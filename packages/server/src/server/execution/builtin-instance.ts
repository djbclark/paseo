import { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type {
  PluginHelperAdmissionRequest,
  PluginHelperAdmissionPermit,
} from "@getpaseo/plugin/internal/activity";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import type { InternalPluginChild } from "../plugins/internal-child.js";
type InternalRuntime = typeof import("../plugins/internal-child.js");
let internalRuntime: InternalRuntime | null = null;
function readInternalPluginExecution(instance: unknown) {
  return internalRuntime?.readInternalPluginExecution(instance);
}
import {
  isQualifiedDaemonOwner,
  readQualifiedBuiltinContext,
  getQualifiedDaemonObservation,
} from "./daemon-owner.js";
import { assertEnclosingAuthorityUnchanged, observeLinuxProcess } from "./daemon-verifier.js";
import {
  assertBuiltinBindings,
  captureBuiltinBindings,
  builtinGlobals,
  builtinRuntimeRequire,
  observeBuiltinBindings,
} from "./builtin-bindings.js";
import type { QualifiedBuiltinArtifact, QualifiedDaemonOwner } from "./daemon-types.js";
import type { QualifiedBuiltinProfile } from "./builtin-profile.js";
import builtinPlugins from "./builtin-inventory.json" with { type: "json" };
interface InstanceRecord {
  owner: QualifiedDaemonOwner;
  id: string;
  instanceId: string;
  child: InternalPluginChild;
  execution: NonNullable<ReturnType<typeof readInternalPluginExecution>>;
  artifact: QualifiedBuiltinArtifact;
  helpers: Map<ChildProcess, HelperRecord>;
  unprovenHelper: boolean;
  closed: boolean;
}
interface HelperRecord {
  leaderClosed: boolean;
  settled: boolean;
  observation: Awaited<ReturnType<typeof observeLinuxProcess>> | null;
  observed: Promise<void>;
  operation: unknown;
}
export type BuiltinHelperRequest = PluginHelperAdmissionRequest;
const instances = new WeakMap<object, InstanceRecord>();
const activityInstances = new WeakMap<object, InstanceRecord>();
const ownerInstances = new WeakMap<object, Set<InstanceRecord>>();
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function retainedBytes(owner: QualifiedDaemonOwner, relative: string): Promise<string> {
  const context = readQualifiedBuiltinContext(owner);
  const identity = context.manifest.files.find((row) => row.path === relative);
  if (
    !identity ||
    path.isAbsolute(relative) ||
    relative.split("/").includes("..") ||
    identity.size > 16 * 1024 * 1024
  )
    throw new Error("Builtin retained member unavailable");
  const handle = await open(
    path.join(owner.root, relative),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== identity.size)
      throw new Error("Invalid retained builtin member");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== identity.size ||
      digest(bytes) !== identity.sha256
    )
      throw new Error("Changed retained builtin member");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
function actualRecord(instance: unknown, owner: unknown, id?: string): InstanceRecord {
  if (!instance || typeof instance !== "object" || !isQualifiedDaemonOwner(owner))
    throw new Error("Builtin instance owner unavailable");
  const record = instances.get(instance);
  if (!record || record.owner !== owner || (id !== undefined && id !== record.id) || record.closed)
    throw new Error("Builtin original instance unavailable");
  const actual = readInternalPluginExecution(instance);
  if (
    !actual ||
    actual.workerIdentity !== record.execution.workerIdentity ||
    actual.activityOwner !== record.execution.activityOwner
  )
    throw new Error("Builtin worker/activity substitution");
  assertBuiltinBindings();
  return record;
}
function profileFor(record: InstanceRecord): QualifiedBuiltinProfile | null {
  const profiles = readQualifiedBuiltinContext(record.owner).profiles;
  const row = profiles?.find((item) => item.id === record.id);
  if (
    !row ||
    row.sourceSha256 !== record.artifact.sourceSha256 ||
    row.serverBundleSha256 !== record.artifact.serverBundleSha256 ||
    row.moduleTableSha256 !== record.artifact.moduleTableSha256 ||
    record.unprovenHelper
  )
    return null;
  return row;
}
/** Only this fixed factory constructs and records the ORIGINAL internal worker. */
export async function createQualifiedBuiltinInstance(owner: QualifiedDaemonOwner, id: string) {
  if (!isQualifiedDaemonOwner(owner) || !builtinPlugins.includes(id))
    throw new Error("Unknown builtin retained identity");
  owner.assertFresh();
  const artifact = readQualifiedBuiltinContext(owner).manifest.builtinArtifacts.find(
    (row) => row.id === id,
  );
  if (!artifact) throw new Error("Builtin artifact missing");
  const serverBundle = await retainedBytes(owner, artifact.factoryPath);
  const manifest = JSON.parse(await retainedBytes(owner, artifact.manifestPath));
  if (digest(serverBundle) !== artifact.serverBundleSha256 || manifest.id !== id)
    throw new Error("Builtin output identity mismatch");
  captureBuiltinBindings();
  const context = readQualifiedBuiltinContext(owner);
  await assertEnclosingAuthorityUnchanged({
    root: owner.root,
    authorityIdentity: context.authorityIdentity,
  });
  owner.assertFresh();
  // Fixed literal import is sealed by the daemon build; v1/source roles never initialize it.
  internalRuntime ??= await import("../plugins/internal-child.js");
  await assertEnclosingAuthorityUnchanged({
    root: owner.root,
    authorityIdentity: context.authorityIdentity,
  });
  owner.assertFresh();
  let record: InstanceRecord | undefined;
  const child = new internalRuntime.InternalPluginChild(
    (source: string): PluginServerContribution => {
      if (!record || source !== serverBundle) throw new Error("Builtin evaluation bytes mismatch");
      actualRecord(child, owner, id);
      const factory: unknown = (0, eval)(serverBundle);
      if (typeof factory !== "function") throw new Error("Builtin factory unavailable");
      const exports: unknown = factory(builtinRuntimeRequire, builtinGlobals);
      const contribute =
        exports && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
      if (typeof contribute !== "function") throw new Error("Builtin contribution unavailable");
      return contribute as PluginServerContribution;
    },
  );
  const execution = readInternalPluginExecution(child);
  if (!execution) throw new Error("Original builtin worker mapping unavailable");
  record = {
    owner,
    id,
    instanceId: randomUUID(),
    child,
    execution,
    artifact,
    helpers: new Map(),
    unprovenHelper: false,
    closed: false,
  };
  instances.set(child, record);
  activityInstances.set(execution.activityOwner, record);
  let cohort = ownerInstances.get(owner);
  if (!cohort) {
    cohort = new Set();
    ownerInstances.set(owner, cohort);
  }
  cohort.add(record);
  child.once("close", () => {
    if (record) record.closed = true;
  });
  return Object.freeze({ child, manifest, serverBundle, clientBundle: null });
}
export function assertQualifiedBuiltinInstance(
  instance: unknown,
  owner: unknown,
  id?: string,
): void {
  const record = actualRecord(instance, owner, id);
  if (!profileFor(record) || [...record.helpers.values()].some((helper) => !helper.settled))
    throw new Error("Builtin maintenance profile unsupported");
}
export function getQualifiedBuiltinObservation(instance: unknown, owner: unknown) {
  const record = actualRecord(instance, owner);
  const profile = profileFor(record);
  const incarnation = record.owner.binding.expectedIncarnation;
  if (typeof incarnation !== "string" || !incarnation)
    throw new Error("Builtin enclosing incarnation unavailable");
  return Object.freeze({
    kind: "builtin-in-process" as const,
    contract: "builtin-in-process-v1" as const,
    id: record.id,
    instanceId: record.instanceId,
    enclosingIncarnation: incarnation,
    distributionBuildId: getQualifiedDaemonObservation(record.owner).distributionBuildId,
    bindings: observeBuiltinBindings(),
    sourceSha256: record.artifact.sourceSha256,
    serverBundleSha256: record.artifact.serverBundleSha256,
    moduleTableSha256: record.artifact.moduleTableSha256,
    profileSha256: profile?.profileSha256 ?? null,
    closure: record.owner.closure,
    helpers: [...record.helpers.values()].map((helper) => ({
      settled: helper.settled,
      observation: helper.observation,
      operation: helper.operation,
    })),
  });
}
/** Called only by the fixed SDK singleton guard. Never cancels ordinary unproven work. */
export function admitBuiltinHelper(request: BuiltinHelperRequest): PluginHelperAdmissionPermit {
  const record = request.activityOwner && activityInstances.get(request.activityOwner);
  if (!record || record.closed) throw new Error("Missing original builtin helper activity");
  if (!request.root) throw new Error("Missing live builtin activity root");
  record.execution.activityOwner.assertLiveRoot(request.root);
  // A profile digest cannot prove an arbitrary provider's descendant closure. Until
  // a finite observed helper family is implemented, the builtin loses maintenance
  // eligibility while its ordinary work continues under the SAME SDK/native lease.
  record.unprovenHelper = true;
  // There is currently no finite proved descendant adapter. This promise is
  // deliberately pending; leader close alone cannot release native ownership.
  const settled = new Promise<void>(() => {
    // Missing finite descendant proof deliberately has no completion source.
  });
  return {
    settled,
    bind(child: ChildProcess): void {
      if (!(child instanceof ChildProcess) || !child.pid) return;
      let operation: unknown = null;
      try {
        operation = {
          kind: request.operation.kind,
          launchRequestSha256: digest(JSON.stringify(request.operation)),
        };
      } catch {
        /* Unrepresentable launch metadata remains unsupported, never cancels work. */
      }
      const helper: HelperRecord = {
        leaderClosed: false,
        settled: false,
        observation: null,
        observed: Promise.resolve(),
        operation,
      };
      record.helpers.set(child, helper);
      child.once("close", () => {
        helper.leaderClosed = true;
      });
      helper.observed = observeLinuxProcess(child.pid)
        .then((observation) => {
          helper.observation = observation;
          return undefined;
        })
        .catch(() => {
          record.unprovenHelper = true;
        });
    },
    failed(_error: unknown): void {
      record.unprovenHelper = true;
    },
  };
}
/** Owner refresh only: observations do not mint eligibility or clear uncertainty. */
export async function refreshBuiltinInstances(owner: object): Promise<void> {
  const records = ownerInstances.get(owner);
  if (!records) return;
  assertBuiltinBindings();
  for (const record of records)
    for (const [child, helper] of record.helpers) {
      await helper.observed;
      if (helper.leaderClosed || !child.pid || !helper.observation) continue;
      const actual = await observeLinuxProcess(child.pid).catch(() => null);
      if (
        !actual ||
        actual.birth !== helper.observation.birth ||
        actual.image !== helper.observation.image
      )
        record.unprovenHelper = true;
    }
}
