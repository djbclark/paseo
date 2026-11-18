import { Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, readFile, type FileHandle } from "node:fs/promises";
import { userInfo, constants as osConstants } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  PluginHelperAdmissionRequest,
  PluginHelperAdmissionPermit,
} from "@getpaseo/plugin/internal/activity";
import type { QualifiedDaemonOwner } from "./daemon-types.js";
import type { FiniteGitProfile } from "./finite-git-profile.js";
import { finiteGitArgv } from "./finite-git-profile.js";
import {
  observeFiniteGitConfig,
  assertFiniteGitConfigUnchanged,
  type FiniteGitConfigProof,
} from "./finite-git-config.js";
import { readQualifiedBuiltinContext, getQualifiedDaemonObservation } from "./daemon-owner.js";
import { readQualifiedBuiltinHelperContext } from "./builtin-instance.js";
import {
  assertEnclosingAuthorityUnchanged,
  assertEnclosingAuthorityUnchangedSync,
  observeLinuxProcess,
} from "./daemon-verifier.js";
import { verifySystemMappings } from "./system-closure.js";
import { canonicalBuiltinJson } from "./builtin-format.js";

type LinuxObservation = Awaited<ReturnType<typeof observeLinuxProcess>>;
interface Prepared {
  owner: QualifiedDaemonOwner;
  instance: object;
  profile: FiniteGitProfile;
  authorityIdentity: string;
  config: FiniteGitConfigProof;
  git: FileHandle;
  gate: FileHandle;
  valid: boolean;
}
const preparations = new WeakMap<object, Prepared>();
const preparationAttempts = new WeakSet<object>();
const fail = (): never => {
  throw new Error("Finite Git execution unsupported");
};
function environmentAllowed(environment: Record<string, string>): boolean {
  return (
    environment.HOME === userInfo().homedir &&
    Object.keys(environment).every(
      (key) =>
        !/^(?:LD_|DYLD_|NODE_|ELECTRON_|PASEO_GIT_GATE_|GLIBC_TUNABLES$)/.test(key) &&
        (!key.startsWith("GIT_") || ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)),
    )
  );
}
async function tool(owner: QualifiedDaemonOwner, relative: string): Promise<FileHandle> {
  const expected = readQualifiedBuiltinContext(owner).manifest.files.find(
    (row) => row.path === relative,
  );
  if (!expected) return fail();
  const descriptor = await open(
    path.join(owner.root, relative),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      before.mode & 0o222n ||
      before.size !== BigInt(expected.size)
    )
      return fail();
    const hash = createHash("sha256");
    let count = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const read = await descriptor.read(buffer, 0, buffer.length, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
      if (count > expected.size) return fail();
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await descriptor.stat({ bigint: true });
    const current = await lstat(path.join(owner.root, relative), { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ] as const)
      if (before[key] !== after[key] || before[key] !== current[key]) return fail();
    if (count !== expected.size || hash.digest("hex") !== expected.sha256) return fail();
    return descriptor;
  } catch (error) {
    await descriptor.close();
    throw error;
  }
}
/** Original private instance only; missing configuration leaves ordinary registration intact. */
export async function prepareQualifiedBuiltinGit(
  instance: object,
  owner: QualifiedDaemonOwner,
): Promise<void> {
  const context = readQualifiedBuiltinHelperContext(instance, owner);
  if (preparationAttempts.has(instance)) return;
  preparationAttempts.add(instance);
  if (context.id !== "worktree-include" || !context.profile?.finiteGit) return;
  const profile = context.profile.finiteGit;
  const observation = getQualifiedDaemonObservation(owner);
  if (
    profile.recipe.distributionManifestSha256 !== observation.manifestSha256 ||
    profile.recipe.systemClosureSha256 !== observation.systemClosureSha256 ||
    !environmentAllowed(profile.recipe.environment)
  )
    return;
  let git: FileHandle | undefined, gate: FileHandle | undefined;
  try {
    const config = await observeFiniteGitConfig(profile.recipe);
    git = await tool(owner, profile.recipe.tools.git);
    gate = await tool(owner, profile.recipe.tools.gate);
    const observer = await tool(owner, profile.recipe.tools.observer);
    await observer.close();
    const authority = readQualifiedBuiltinContext(owner);
    await assertEnclosingAuthorityUnchanged({
      root: owner.root,
      authorityIdentity: authority.authorityIdentity,
    });
    owner.assertFresh();
    assertFiniteGitConfigUnchanged(config);
    preparations.set(instance, {
      owner,
      instance,
      profile,
      authorityIdentity: authority.authorityIdentity,
      config,
      git,
      gate,
      valid: true,
    });
  } catch {
    await git?.close();
    await gate?.close();
    // This is a configuration/eligibility failure, never permission to disable normal work.
  }
}
/** Internal private-map assertion, not a public flag or a source of authority. */
export function assertPreparedQualifiedBuiltinGit(
  instance: object,
  owner: QualifiedDaemonOwner,
): void {
  const prepared = preparations.get(instance);
  if (!prepared || prepared.owner !== owner || !prepared.valid) return fail();
  try {
    owner.assertFresh();
    assertFiniteGitConfigUnchanged(prepared.config);
    assertEnclosingAuthorityUnchangedSync({
      root: owner.root,
      authorityIdentity: prepared.authorityIdentity,
    });
  } catch (error) {
    prepared.valid = false;
    try {
      readQualifiedBuiltinHelperContext(instance, owner).activityOwner.markUnknown();
    } catch {
      /* Keep original work alive. */
    }
    throw error;
  }
}
function assertCurrent(prepared: Prepared, request: PluginHelperAdmissionRequest): void {
  if (!prepared.valid) return fail();
  prepared.owner.assertFresh();
  const context = readQualifiedBuiltinHelperContext(prepared.instance, prepared.owner);
  if (
    context.activityOwner !== request.activityOwner ||
    !request.root ||
    context.profile?.finiteGit?.recipeSha256 !== prepared.profile.recipeSha256
  )
    return fail();
  context.activityOwner.assertLiveRoot(request.root);
  assertFiniteGitConfigUnchanged(prepared.config);
  assertEnclosingAuthorityUnchangedSync({
    root: prepared.owner.root,
    authorityIdentity: prepared.authorityIdentity,
  });
}
function requestFits(
  prepared: Prepared,
  request: PluginHelperAdmissionRequest,
): "ls-files" | "check-ignore" | null {
  const { operation } = request;
  if (
    operation.kind !== "execFile" ||
    operation.command !== "git" ||
    operation.options.cwd !== prepared.profile.recipe.repository.cwd ||
    operation.options.maxBuffer !== 64 * 1024 * 1024 ||
    Object.keys(operation.options).some((key) => !["cwd", "maxBuffer", "env"].includes(key))
  )
    return null;
  const environment = Object.fromEntries(
    Object.entries(operation.options.env ?? process.env).filter((entry) => entry[1] !== undefined),
  );
  if (
    canonicalBuiltinJson(environment) !== canonicalBuiltinJson(prepared.profile.recipe.environment)
  )
    return null;
  const argv = canonicalBuiltinJson([...operation.args]);
  if (argv === canonicalBuiltinJson(finiteGitArgv.lsFiles)) return "ls-files";
  if (argv === canonicalBuiltinJson(finiteGitArgv.checkIgnore)) return "check-ignore";
  return null;
}
type WireMessage =
  | { kind: "spawn" | "ready"; pid: number }
  | { kind: "leader"; pid: number; code: number; signal: number }
  | { kind: "complete"; pid: number; code: number; signal: number; observed: boolean };
function terminalNumbers(fields: string[]): { code: number; signal: number } {
  if (
    !/^(?:-1|0|[1-9][0-9]{0,2})$/.test(fields[3] ?? "") ||
    !/^(?:0|[1-9][0-9]?)$/.test(fields[4] ?? "")
  )
    return fail();
  const code = Number(fields[3]),
    signal = Number(fields[4]);
  if (code > 255 || signal > 64) return fail();
  return { code, signal };
}
function parseWireMessage(line: string, nonce: string, sequence: number): WireMessage {
  const fields = line.split(" ");
  const kind = fields[0],
    pid = Number(fields[2]);
  if (
    fields[1] !== nonce ||
    kind !== ["spawn", "ready", "leader", "complete"][sequence - 1] ||
    !/^[1-9][0-9]*$/.test(fields[2] ?? "") ||
    !Number.isSafeInteger(pid)
  )
    return fail();
  if (kind === "spawn" || kind === "ready") {
    if (fields.length !== 3) return fail();
    return { kind, pid };
  }
  const terminal = terminalNumbers(fields);
  if (kind === "leader") {
    if (fields.length !== 5) return fail();
    return { kind, pid, ...terminal };
  }
  if (kind !== "complete" || fields.length !== 6 || !["observed", "unknown"].includes(fields[5]!))
    return fail();
  return { kind, pid, ...terminal, observed: fields[5] === "observed" };
}
export interface QualifiedGitPermit extends PluginHelperAdmissionPermit {
  readonly observed: Promise<LinuxObservation | null>;
  observation(): unknown;
}
/** No caller callback or JSON value can insert a preparation or choose launch arguments. */
export function qualifiedBuiltinGitPermit(
  instance: object,
  owner: QualifiedDaemonOwner,
  request: PluginHelperAdmissionRequest,
): QualifiedGitPermit | null {
  const prepared = preparations.get(instance);
  if (!prepared || prepared.owner !== owner || !prepared.valid) return null;
  const original = readQualifiedBuiltinHelperContext(instance, owner);
  if (!original.profile?.finiteGit) return null;
  let operation: "ls-files" | "check-ignore" | null;
  try {
    operation = requestFits(prepared, request);
  } catch {
    return null;
  }
  if (!operation) return null;
  try {
    assertCurrent(prepared, request);
  } catch {
    prepared.valid = false;
    try {
      original.activityOwner.markUnknown();
    } catch {
      /* Original work must continue. */
    }
    return null;
  }
  const nonce = randomBytes(32).toString("hex");
  let started = false,
    child: ChildProcess | undefined,
    bound = false,
    closed = false,
    exited = false;
  let gitPid: number | undefined,
    observerIdentity: LinuxObservation | null = null,
    gitIdentity: LinuxObservation | null = null;
  let completion: { code: number; signal: number; observed: boolean } | undefined;
  let leader: { code: number; signal: number } | undefined;
  let resolveSettled!: () => void, resolveObserved!: (value: LinuxObservation | null) => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const observed = new Promise<LinuxObservation | null>((resolve) => {
    resolveObserved = resolve;
  });
  const environment = { ...prepared.profile.recipe.environment };
  const args = [...request.operation.args];
  const options = { cwd: prepared.profile.recipe.repository.cwd, env: environment };
  const unknown = () => {
    prepared.valid = false;
    try {
      original.activityOwner.markUnknown();
    } catch {
      /* Never cancel original work for proof. */
    }
    resolveObserved(null);
  };
  function endControl(value?: string): void {
    const stream = child?.stdio[4];
    try {
      if (stream instanceof Writable) stream.end(value);
      else unknown();
    } catch {
      unknown();
    }
  }
  async function ready(pid: number): Promise<void> {
    if (!child?.pid || exited || gitPid !== pid || gitIdentity) return fail();
    const observer = await observeLinuxProcess(child.pid);
    if (
      observer.executable !== path.join(owner.root, prepared!.profile.recipe.tools.observer) ||
      exited
    )
      return fail();
    const parentStatus = await readFile(`/proc/${child.pid}/stat`, "utf8");
    if (Number(parentStatus.slice(parentStatus.lastIndexOf(")") + 2).split(" ")[1]) !== process.pid)
      return fail();
    const actual = await observeLinuxProcess(pid);
    const status = await readFile(`/proc/${pid}/stat`, "utf8");
    if (
      Number(status.slice(status.lastIndexOf(")") + 2).split(" ")[1]) !== child.pid ||
      actual.executable !== path.join(owner.root, prepared!.profile.recipe.tools.git) ||
      exited
    )
      return fail();
    const context = readQualifiedBuiltinContext(owner);
    const mapped = await verifySystemMappings(owner.root, context.manifest, pid);
    await verifySystemMappings(owner.root, context.manifest, child.pid);
    const system = getQualifiedDaemonObservation(owner).systemObservation;
    if (
      mapped.namespaceIdentity !== system.namespaceIdentity ||
      mapped.mountinfoSha256 !== system.mountinfoSha256 ||
      exited
    )
      return fail();
    await assertEnclosingAuthorityUnchanged({
      root: owner.root,
      authorityIdentity: prepared!.authorityIdentity,
    });
    assertCurrent(prepared!, request);
    if (!bound || exited) return fail();
    observerIdentity = observer;
    gitIdentity = actual;
    resolveObserved(observer);
    endControl(`resume ${nonce}\n`);
  }
  let pipeline = Promise.resolve(),
    pending = "",
    bytes = 0,
    count = 0;
  function message(line: string): void {
    const value = parseWireMessage(line, nonce, ++count);
    if (value.kind === "spawn") {
      gitPid = value.pid;
      return;
    }
    if (value.pid !== gitPid) return fail();
    if (value.kind === "ready") {
      pipeline = pipeline
        .then(() => ready(value.pid))
        .catch(() => {
          unknown();
          endControl();
        });
      return;
    }
    if (value.kind === "leader") {
      leader = { code: value.code, signal: value.signal };
      return;
    }
    if (
      value.kind !== "complete" ||
      !leader ||
      leader.code !== value.code ||
      leader.signal !== value.signal
    )
      return fail();
    completion = { code: value.code, signal: value.signal, observed: value.observed };
    if (!completion.observed) unknown();
  }
  function data(buffer: Buffer): void {
    bytes += buffer.length;
    if (buffer.some((value) => value > 127)) {
      unknown();
      endControl();
      return;
    }
    if (bytes > 1024) {
      unknown();
      endControl();
      return;
    }
    pending += buffer.toString("ascii");
    const lines = pending.split("\n");
    pending = lines.pop()!;
    try {
      for (const line of lines) message(line);
    } catch {
      unknown();
      endControl();
    }
  }
  async function close(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    closed = true;
    await pipeline;
    const actualSignal = signal ? osConstants.signals[signal] : 0;
    if (
      !bound ||
      !prepared!.valid ||
      !gitIdentity ||
      !observerIdentity ||
      pending ||
      !completion?.observed ||
      completion.code !== (code ?? -1) ||
      completion.signal !== actualSignal
    ) {
      unknown();
      return;
    }
    await assertEnclosingAuthorityUnchanged({
      root: owner.root,
      authorityIdentity: prepared!.authorityIdentity,
    });
    assertCurrent(prepared!, request);
    resolveSettled();
  }
  return {
    settled,
    observed,
    observation: () =>
      Object.freeze({
        contract: "finite-git-fd-gate-v1",
        recipeSha256: prepared.profile.recipeSha256,
        nonce,
        observer: observerIdentity,
        git: gitIdentity,
        completion: completion ?? null,
        closed,
      }),
    builtinExecFile: {
      start(): ChildProcess {
        if (started) return fail();
        started = true;
        try {
          assertCurrent(prepared!, request);
        } catch {
          unknown();
          child = spawn("git", args, options);
          return child;
        }
        child = spawn(
          path.join(owner.root, prepared!.profile.recipe.tools.observer),
          [nonce, operation!],
          {
            ...options,
            stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", prepared!.git.fd, prepared!.gate.fd],
          },
        );
        child.stdio[3]?.on("data", data);
        for (const stream of [child.stdio[3], child.stdio[4]]) stream?.on("error", unknown);
        child.once("error", unknown);
        child.once("exit", () => {
          exited = true;
        });
        child.once("close", (code, signal) => {
          void close(code, signal).catch(unknown);
        });
        return child;
      },
    },
    bind(actual: ChildProcess): void {
      if (!started || actual !== child || bound) {
        unknown();
        return;
      }
      bound = true;
    },
    failed: unknown,
  };
}
