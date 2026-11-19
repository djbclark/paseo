import { Writable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, readFile, readlink, type FileHandle } from "node:fs/promises";
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
import { assertEnclosingAuthorityUnchanged, observeLinuxProcess } from "./daemon-verifier.js";
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
    await assertFiniteGitConfigUnchanged(config);
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
/** Memory-only contract assertion; owner.refresh provides actual async freshness. */
export function assertPreparedQualifiedBuiltinGit(
  instance: object,
  owner: QualifiedDaemonOwner,
): void {
  const prepared = preparations.get(instance);
  if (!prepared || prepared.owner !== owner || !prepared.valid) return fail();
  owner.assertFresh();
}
export async function refreshPreparedQualifiedBuiltinGit(
  instance: object,
  owner: QualifiedDaemonOwner,
): Promise<void> {
  const prepared = preparations.get(instance);
  if (!prepared) return;
  if (prepared.owner !== owner || !prepared.valid) return fail();
  try {
    await assertFiniteGitConfigUnchanged(prepared.config);
    await assertEnclosingAuthorityUnchanged({
      root: owner.root,
      authorityIdentity: prepared.authorityIdentity,
    });
    if (!prepared.valid) return fail();
  } catch (error) {
    prepared.valid = false;
    try {
      readQualifiedBuiltinHelperContext(instance, owner).activityOwner.markUnknown();
    } catch {
      /* Keep admitted work alive. */
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
  | { kind: "preflight" | "spawn" | "ready"; pid: number }
  | { kind: "unobserved"; pid: number; phase: "preflight" | "postexec" }
  | {
      kind: "exec-error" | "launch-error";
      pid: number;
      syscall: "fork" | "execveat" | "execvp";
      errno: number;
    }
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
function parseWireMessage(line: string, nonce: string): WireMessage {
  const fields = line.split(" ");
  const kind = fields[0],
    pid = Number(fields[2]);
  if (
    fields[1] !== nonce ||
    line.length > 191 ||
    !/^[1-9][0-9]*$/.test(fields[2] ?? "") ||
    !Number.isSafeInteger(pid)
  )
    return fail();
  if (kind === "preflight" || kind === "spawn" || kind === "ready") {
    if (fields.length !== 3) return fail();
    return { kind, pid };
  }
  if (kind === "unobserved") {
    const phase = fields[3];
    if (fields.length !== 4 || (phase !== "preflight" && phase !== "postexec")) return fail();
    return { kind, pid, phase };
  }
  if (kind === "exec-error" || kind === "launch-error") {
    const syscall = fields[3];
    const errno = Number(fields[4]);
    if (fields.length !== 5 || !/^[1-9][0-9]{0,3}$/.test(fields[4] ?? "") || errno > 4095)
      return fail();
    if (kind === "launch-error") {
      if (syscall !== "fork") return fail();
      return { kind, pid, syscall: "fork", errno };
    }
    if (syscall !== "execveat" && syscall !== "execvp") return fail();
    return { kind, pid, syscall, errno };
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
  let execFailure: Readonly<{ errno: number; syscall: "fork" | "execveat" | "execvp" }> | null =
    null;
  let phase = 0;
  let observationDeadline: NodeJS.Timeout | undefined;
  function clearDeadline(): void {
    if (observationDeadline) clearTimeout(observationDeadline);
    observationDeadline = undefined;
  }
  function armDeadline(milliseconds: number): void {
    clearDeadline();
    observationDeadline = setTimeout(() => {
      unknown();
      endControl();
    }, milliseconds);
  }
  let resolveSettled!: () => void, resolveObserved!: (value: LinuxObservation | null) => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const observed = new Promise<LinuxObservation | null>((resolve) => {
    resolveObserved = resolve;
  });
  let environment: Record<string, string> = {};
  let args: string[] = [];
  let options: { cwd: string; env: Record<string, string> } = {
    cwd: prepared.profile.recipe.repository.cwd,
    env: environment,
  };
  const unknown = () => {
    clearDeadline();
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
  function launchControl(): void {
    const stream = child?.stdio[4];
    if (!(stream instanceof Writable)) return fail();
    stream.write(`launch ${nonce}\n`);
  }
  async function bounded(action: () => Promise<void>, milliseconds: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Finite Git observation deadline")), milliseconds);
    });
    try {
      await Promise.race([action(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function preflight(pid: number): Promise<void> {
    const actualChild = child;
    if (!actualChild?.pid || actualChild.pid !== pid || exited || !bound) return fail();
    const observation = await observeLinuxProcess(pid);
    if (observation.executable !== path.join(owner.root, prepared!.profile.recipe.tools.observer))
      return fail();
    const status = await readFile(`/proc/${pid}/stat`, "utf8");
    if (Number(status.slice(status.lastIndexOf(")") + 2).split(" ")[1]) !== process.pid)
      return fail();
    const cwd = await readlink(`/proc/${pid}/cwd`);
    const actualEnvironment = Object.fromEntries(
      (await readFile(`/proc/${pid}/environ`, "utf8"))
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const split = entry.indexOf("=");
          return [entry.slice(0, split), entry.slice(split + 1)];
        }),
    );
    const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    command.pop();
    if (
      cwd !== options.cwd ||
      canonicalBuiltinJson(actualEnvironment) !== canonicalBuiltinJson(environment) ||
      canonicalBuiltinJson(command) !==
        canonicalBuiltinJson([
          path.join(owner.root, prepared!.profile.recipe.tools.observer),
          nonce,
          operation,
        ])
    )
      return fail();
    const context = readQualifiedBuiltinContext(owner);
    const mapped = await verifySystemMappings(owner.root, context.manifest, pid);
    const system = getQualifiedDaemonObservation(owner).systemObservation;
    if (
      mapped.namespaceIdentity !== system.namespaceIdentity ||
      mapped.mountinfoSha256 !== system.mountinfoSha256
    )
      return fail();
    await refreshPreparedQualifiedBuiltinGit(instance, owner);
    assertCurrent(prepared!, request);
    if (exited || !bound) return fail();
    observerIdentity = observation;
    launchControl();
    armDeadline(4000);
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
    await refreshPreparedQualifiedBuiltinGit(instance, owner);
    assertCurrent(prepared!, request);
    if (!bound || exited) return fail();
    observerIdentity = observer;
    gitIdentity = actual;
    clearDeadline();
    resolveObserved(observer);
    endControl(`resume ${nonce}\n`);
  }
  let pipeline = Promise.resolve(),
    pending = "",
    bytes = 0,
    count = 0;
  function message(line: string): void {
    if (++count > 8) return fail();
    const value = parseWireMessage(line, nonce);
    if (value.kind === "unobserved") {
      if (value.pid !== child?.pid || phase < 1) return fail();
      unknown();
      endControl();
      return;
    }
    if (value.kind === "launch-error" || value.kind === "exec-error") {
      const expected = value.kind === "launch-error" ? child?.pid : gitPid;
      if (
        value.pid !== expected ||
        execFailure ||
        (value.kind === "launch-error" ? phase !== 1 : phase !== 2)
      )
        return fail();
      execFailure = Object.freeze({ errno: value.errno, syscall: value.syscall });
      unknown();
      endControl();
      return;
    }
    if (value.kind === "preflight") {
      if (phase !== 0 || value.pid !== child?.pid) return fail();
      phase = 1;
      clearDeadline();
      pipeline = pipeline
        .then(() => bounded(() => preflight(value.pid), 4000))
        .catch(() => {
          unknown();
          endControl();
        });
      return;
    }
    if (value.kind === "spawn") {
      if (phase !== 1 || gitPid) return fail();
      phase = 2;
      gitPid = value.pid;
      return;
    }
    if (value.pid !== gitPid) return fail();
    if (value.kind === "ready") {
      if (phase !== 2) return fail();
      phase = 3;
      clearDeadline();
      pipeline = pipeline
        .then(() => bounded(() => ready(value.pid), 3000))
        .catch(() => {
          unknown();
          endControl();
        });
      return;
    }
    if (value.kind === "leader") {
      if (phase !== 2 && phase !== 3) return fail();
      phase = 4;
      leader = { code: value.code, signal: value.signal };
      return;
    }
    if (
      value.kind !== "complete" ||
      phase !== 4 ||
      !leader ||
      leader.code !== value.code ||
      leader.signal !== value.signal
    )
      return fail();
    phase = 5;
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
    clearDeadline();
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
    await refreshPreparedQualifiedBuiltinGit(instance, owner);
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
      readExecFailure: () => (closed ? execFailure : null),
      start(): ChildProcess {
        if (started) return fail();
        started = true;
        // Capture actual mutable inputs at synchronous start, before any await.
        args = [...request.operation.args];
        const originalOptions = { ...request.operation.options };
        const rawEnvironment = { ...(originalOptions.env ?? process.env) };
        environment = Object.fromEntries(
          Object.entries(rawEnvironment).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        options = { cwd: prepared!.profile.recipe.repository.cwd, env: environment };
        const snapshot = {
          ...request,
          operation: {
            ...request.operation,
            args,
            options: { ...originalOptions, env: environment },
          },
        };
        try {
          if (
            Object.entries(rawEnvironment).some(
              (entry) => entry[1] !== undefined && typeof entry[1] !== "string",
            )
          )
            return fail();
          if (requestFits(prepared!, snapshot) !== operation) return fail();
          assertCurrent(prepared!, snapshot);
        } catch {
          unknown();
          child = spawn(request.operation.command, args, {
            ...originalOptions,
            env: rawEnvironment,
          });
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
        armDeadline(4000);
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
