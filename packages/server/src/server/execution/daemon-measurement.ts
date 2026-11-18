import builtinPlugins from "./builtin-inventory.json" with { type: "json" };
import { cloneBoundedObservation, parseQualifiedMeasurementRequest } from "./measurement-format.js";
export { parseQualifiedMeasurementRequest } from "./measurement-format.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import * as pluginService from "../plugins/index.js";
import * as protocol from "@getpaseo/protocol/messages";
import { assertQualifiedWorkerTerminalManager } from "../../terminal/worker-terminal-manager.js";
import { getQualifiedDaemonObservation, isQualifiedDaemonOwner } from "./daemon-owner.js";
import type {
  QualifiedDaemonOwner,
  QualifiedDaemonObservation,
  QualifiedClosure,
} from "./daemon-types.js";
import type { PaseoDaemon } from "../bootstrap.js";

// Captured while verified trusted modules load, before daemon lifecycle/candidate startup.
const parentChannel = process.channel;
const parentPid = process.ppid;
const sendToParent = process.send?.bind(process);
const onMessage = process.on.bind(process);
const offMessage = process.off.bind(process);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Closure = z
  .object({
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    qualificationSha256: Digest,
  })
  .strict();
const Trigger = z
  .object({
    generation: z.number().int().nonnegative(),
    transactionId: z.string().min(1).max(256),
    operation: z.enum(["replace", "recover", "verify"]),
    pluginId: z.string().min(1).max(256),
    expectedGeneration: z.number().int().nonnegative(),
  })
  .strict();
const Run = z
  .object({
    threadId: z.number().int().positive(),
    incarnation: z.string().min(1).max(512),
    sourceDirectory: z.string(),
    snapshotRoot: z.string(),
    snapshotSha256: Digest,
    serverBundleBase64: z.string().max(8388608),
    serverBundleSha256: Digest,
    serverBundleByteLength: z.number().int().positive().max(6291456),
    clientBundleBase64: z.string().max(8388608).nullable(),
    clientBundleSha256: Digest.nullable(),
    closure: Closure,
    settled: z.literal(true),
    trigger: Trigger,
  })
  .strict();
const Runtime = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    observationEpoch: z.number().int().nonnegative(),
    compiler: z
      .object({
        runs: z.array(Run).max(8),
        coldPair: z
          .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
          .nullable(),
      })
      .strict()
      .nullable(),
    plugins: z.unknown(),
  })
  .strict();
type RunData = z.infer<typeof Run>;
interface TerminalObservation {
  pid: number;
  incarnation: string;
}
interface MeasurementResponse {
  type: "qualified.measurement.response";
  schemaVersion: 1 | 2;
  nonce: string;
  parentPid: number;
  status: "observed" | "hold";
  reason?: string;
  daemon: QualifiedDaemonObservation | null;
  runtime: unknown;
  terminal: TerminalObservation | null;
}

function sameClosure(a: QualifiedClosure, b: QualifiedClosure): boolean {
  return (
    a.runtimeClosureSha256 === b.runtimeClosureSha256 &&
    a.helperClosureSha256 === b.helperClosureSha256 &&
    a.qualificationSha256 === b.qualificationSha256
  );
}
function verifyBytes(encoded: string, expected: string, length?: number): void {
  const raw = Buffer.from(encoded, "base64");
  if (
    raw.toString("base64") !== encoded ||
    (length !== undefined && raw.length !== length) ||
    createHash("sha256").update(raw).digest("hex") !== expected
  )
    throw new Error("Compiler byte observation mismatch");
}
function verifyRun(run: RunData, closure: QualifiedClosure): void {
  for (const directory of [run.sourceDirectory, run.snapshotRoot])
    if (
      !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory ||
      directory.includes("\0")
    )
      throw new Error("Compiler source observation invalid");
  if (!sameClosure(run.closure, closure)) throw new Error("Compiler executing closure mismatch");
  verifyBytes(run.serverBundleBase64, run.serverBundleSha256, run.serverBundleByteLength);
  if (run.clientBundleBase64 === null) {
    if (run.clientBundleSha256 !== null) throw new Error("Client observation mismatch");
  } else {
    if (run.clientBundleSha256 === null) throw new Error("Client observation missing digest");
    verifyBytes(run.clientBundleBase64, run.clientBundleSha256);
  }
}
function verifyColdPair(
  compiler: NonNullable<z.infer<typeof Runtime>["compiler"]>,
  closure: QualifiedClosure,
): boolean {
  for (const run of compiler.runs) verifyRun(run, closure);
  if (!compiler.coldPair) return false;
  const [a, b] = compiler.coldPair;
  const first = compiler.runs[a];
  const last = compiler.runs[b];
  if (
    !first ||
    !last ||
    a === b ||
    first.threadId === last.threadId ||
    first.incarnation === last.incarnation
  )
    return false;
  return (
    first.sourceDirectory === last.sourceDirectory &&
    first.snapshotRoot === last.snapshotRoot &&
    first.snapshotSha256 === last.snapshotSha256 &&
    first.serverBundleSha256 === last.serverBundleSha256 &&
    first.clientBundleSha256 === last.clientBundleSha256
  );
}
function boundedData(response: MeasurementResponse): MeasurementResponse {
  return cloneBoundedObservation(response) as MeasurementResponse;
}

function hold(
  nonce: string,
  reason: string,
  daemon: QualifiedDaemonObservation | null = null,
  terminal: TerminalObservation | null = null,
): MeasurementResponse {
  return {
    type: "qualified.measurement.response",
    schemaVersion: 1,
    nonce,
    parentPid,
    status: "hold",
    reason,
    daemon,
    runtime: null,
    terminal,
  };
}
function parseCohort(
  raw: unknown,
  daemon: QualifiedDaemonObservation,
  serverId: string,
  version: 1 | 2,
): unknown | null {
  const schema: unknown = Reflect.get(
    protocol,
    version === 2 ? "ManagedPluginCohortV2StatusSchema" : "ManagedPluginCohortStatusSchema",
  );
  if (!schema || typeof schema !== "object") return null;
  const parse: unknown = Reflect.get(schema, "safeParse");
  if (typeof parse !== "function") return null;
  const parsed = parse.call(schema, raw) as { success: boolean; data?: unknown };
  if (!parsed.success || !parsed.data || typeof parsed.data !== "object") return null;
  const cohort = parsed.data;
  const entries: unknown = Reflect.get(cohort, "entries");
  if (!Array.isArray(entries) || entries.length > 128) return null;
  if (Reflect.get(cohort, "consistency") !== "coherent") return null;
  const enclosing: unknown = Reflect.get(cohort, "enclosing");
  if (
    !enclosing ||
    typeof enclosing !== "object" ||
    Reflect.get(enclosing, "serverId") !== serverId ||
    Reflect.get(enclosing, "incarnation") !== daemon.incarnation ||
    Reflect.get(enclosing, "distributionBuildId") !== daemon.distributionBuildId
  )
    return null;
  if (version === 2 && !completeBuiltinCohort(entries)) return null;
  const closure = Closure.safeParse(Reflect.get(enclosing, "closure"));
  if (!closure.success || !sameClosure(closure.data, daemon.closure)) return null;
  return cohort;
}
function completeBuiltinCohort(entries: unknown[]): boolean {
  const rows = entries.filter(
    (row) => row && typeof row === "object" && Reflect.get(row, "kind") === "builtin-in-process",
  ) as object[];
  if (
    JSON.stringify(rows.map((row) => Reflect.get(row, "pluginId")).sort()) !==
    JSON.stringify(builtinPlugins)
  )
    return false;
  return rows.every(
    (row) =>
      Reflect.get(row, "enabled") === true &&
      Reflect.get(row, "loaded") !== null &&
      Reflect.get(row, "execution") !== null,
  );
}
async function collect(
  owner: QualifiedDaemonOwner,
  daemon: PaseoDaemon,
  nonce: string,
  version: 1 | 2,
): Promise<MeasurementResponse> {
  await owner.refresh();
  const before = getQualifiedDaemonObservation(owner);
  const getter: unknown = Reflect.get(
    pluginService,
    version === 2 ? "getQualifiedRuntimeMeasurementV2" : "getQualifiedRuntimeMeasurement",
  );
  const epochGetter: unknown = Reflect.get(pluginService, "getQualifiedRuntimeMeasurementEpoch");
  if (typeof getter !== "function" || typeof epochGetter !== "function")
    return { ...hold(nonce, "runtime-observer-unavailable", before), schemaVersion: version };
  const parsed = Runtime.safeParse(await getter(owner));
  const held = (
    reason: string,
    observed: QualifiedDaemonObservation | null = null,
    terminal: TerminalObservation | null = null,
  ) => ({ ...hold(nonce, reason, observed, terminal), schemaVersion: version });
  await owner.refresh();
  const after = getQualifiedDaemonObservation(owner);
  if (JSON.stringify(before) !== JSON.stringify(after)) return held("owned-cohort-changed");
  assertQualifiedWorkerTerminalManager(daemon.terminalManager, owner);
  const terminals = after.ownedHandles.filter((row) => row.kind === "terminal-worker");
  if (terminals.length !== 1) return held("terminal-observation-unavailable", after);
  const terminal = { pid: terminals[0]!.pid, incarnation: terminals[0]!.incarnation };
  if (
    !parsed.success ||
    parsed.data.version !== version ||
    epochGetter(owner) !== parsed.data.observationEpoch
  )
    return held("runtime-observation-changed", after, terminal);
  const cohort = parseCohort(parsed.data.plugins, after, daemon.getServerId(), version);
  if (!cohort || !parsed.data.compiler || !verifyColdPair(parsed.data.compiler, after.closure))
    return held("runtime-facts-incomplete", after, terminal);
  return boundedData({
    type: "qualified.measurement.response",
    schemaVersion: version,
    nonce,
    parentPid,
    status: "observed",
    daemon: after,
    terminal,
    runtime: { ...parsed.data, plugins: cohort },
  });
}
/** Read-only original parent IPC. No caller transport, selector, config toggle or work dispatch. */
export function attachQualifiedDaemonMeasurement(owner: QualifiedDaemonOwner) {
  if (
    !isQualifiedDaemonOwner(owner) ||
    !parentChannel ||
    !sendToParent ||
    !process.connected ||
    process.channel !== parentChannel ||
    process.ppid !== parentPid
  )
    throw new Error("Owned parent measurement transport unavailable");
  let daemon: PaseoDaemon | null = null;
  let busy = false;
  let closed = false;
  const connected = () =>
    !closed && process.connected && process.channel === parentChannel && process.ppid === parentPid;
  const send = (response: MeasurementResponse) => {
    if (connected()) sendToParent(boundedData(response), () => {});
  };
  const receive = (raw: unknown) => {
    const request = parseQualifiedMeasurementRequest(raw);
    if (!request || !connected()) return;
    if (!daemon) {
      send({ ...hold(request.nonce, "starting"), schemaVersion: request.schemaVersion });
      return;
    }
    if (busy) {
      send({ ...hold(request.nonce, "busy"), schemaVersion: request.schemaVersion });
      return;
    }
    busy = true;
    void collect(owner, daemon, request.nonce, request.schemaVersion)
      .then((response) => {
        send(response);
        return undefined;
      })
      .catch(() => {
        send({
          ...hold(request.nonce, "observation-unavailable"),
          schemaVersion: request.schemaVersion,
        });
      })
      .finally(() => {
        busy = false;
      });
  };
  onMessage("message", receive);
  return Object.freeze({
    started(actual: PaseoDaemon): void {
      if (daemon || !connected()) throw new Error("Measurement startup binding invalid");
      assertQualifiedWorkerTerminalManager(actual.terminalManager, owner);
      daemon = actual;
    },
    close(): void {
      closed = true;
      offMessage("message", receive);
    },
  });
}
