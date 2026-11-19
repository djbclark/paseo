import { write } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

export const STARTUP_PHASE_PREFIX = "PASEO_STARTUP_PHASE ";
const phases = [
  "plugin.pre-scope-refresh",
  "plugin.pre-dispatch-refresh",
  "plugin.post-ready-refresh",
  "plugin.initialize-send",
  "worker.initialize-received",
  "worker.connect",
  "worker.load",
  "worker.contribute",
  "worker.usage-metadata",
  "worker.init-drain",
  "worker.ready-send",
  "owner.refresh",
  "owner.verify",
  "owner.environment",
  "owner.observers",
  "owner.builtins",
  "owner.authority",
  "owner.exchange",
  "verify.total",
  "verify.policy",
  "verify.tree",
  "verify.files",
  "verify.runtime",
  "verify.externals",
  "verify.system",
  "verify.process",
  "verify.maps",
  "verify.authority",
  "terminal.verify",
  "cli.total",
] as const;
const counters = [
  "directories",
  "files",
  "declaredBytes",
  "readBytes",
  "batches",
  "maxWidth",
  "maxReservedBytes",
  "pluginObservers",
  "compilerObservers",
  "terminalObservers",
] as const;
export type StartupPhase = (typeof phases)[number];
export type StartupPhaseCounter = (typeof counters)[number];
export interface StartupPhaseEvent {
  phase: StartupPhase;
  edge: "begin" | "end" | "point" | "add";
  span?: number;
  cycle?: number;
  relation?: "new" | "join";
  durationUs?: number;
  builtinOrdinal?: number;
  outcome?: "ok" | "error" | "incomplete";
  counter?: StartupPhaseCounter;
  value?: number;
}
const eventKeys = new Set([
  "phase",
  "edge",
  "span",
  "cycle",
  "relation",
  "durationUs",
  "builtinOrdinal",
  "outcome",
  "counter",
  "value",
]);
const rowKeys = new Set([
  "version",
  "pid",
  "seq",
  "role",
  "phase",
  "edge",
  "elapsedUs",
  "span",
  "cycle",
  "relation",
  "durationUs",
  "builtinOrdinal",
  "outcome",
  "counter",
  "value",
]);
const roles: Record<string, string> = {
  "role.cjs": "daemon",
  "cli-entry.mjs": "cli",
  "terminal-entry.mjs": "terminal",
  "plugin-child-entry.mjs": "plugin-child",
};
const entryLabel = basename(process.argv[1] ?? "");
const role = isMainThread && Object.hasOwn(roles, entryLabel) ? roles[entryLabel] : undefined;
const limits: Record<string, { records: number; bytes: number }> = {
  daemon: { records: 2048, bytes: 524288 },
  terminal: { records: 256, bytes: 65536 },
  "plugin-child": { records: 64, bytes: 16384 },
  cli: { records: 1, bytes: 256 },
};
const limit = limits[role ?? "cli"];
const originalWrite = write;
const clock = performance.now.bind(performance);
const actualPid = process.pid;
let broken = false;
let finalQueued = false;
let seq = 0;
let records = 0;
let bytes = 0;
let queuedBytes = 0;
let writing = false;
let queue: Buffer[] = [];
const totals = { readBytes: 0, declaredBytes: 0, files: 0 };
const spans = new Map<string, Partial<Record<StartupPhaseCounter, number>>>();
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** Captured local clock DATA only; failure cannot escape into the original work. */
export function startupPhaseNow(): number | null {
  try {
    const value = Math.floor(clock() * 1000);
    if (integer(value)) return value;
  } catch {
    /* Diagnostic clock failure only. */
  }
  broken = true;
  return null;
}
const origin = startupPhaseNow();
function pump(): void {
  if (writing || !queue.length) return;
  const buffer = queue.shift()!;
  queuedBytes -= buffer.length;
  writing = true;
  try {
    originalWrite(2, buffer, 0, buffer.length, null, (error, written) => {
      try {
        writing = false;
        if (error || written !== buffer.length) {
          broken = true;
          queue = [];
          queuedBytes = 0;
          incomplete();
          return;
        }
        pump();
      } catch {
        broken = true;
        queue = [];
        queuedBytes = 0;
        incomplete();
      }
    });
  } catch {
    writing = false;
    broken = true;
    queue = [];
    queuedBytes = 0;
    incomplete();
  }
}
function enqueue(line: Buffer, final: boolean): boolean {
  const reserve = final || role === "cli" ? 0 : 256;
  if (
    line.length > 256 ||
    records + 1 > limit.records - (reserve ? 1 : 0) ||
    bytes + line.length > limit.bytes - reserve ||
    queuedBytes + line.length > 16384 - reserve
  )
    return false;
  records++;
  bytes += line.length;
  queue.push(line);
  queuedBytes += line.length;
  pump();
  return true;
}
function elapsed(): number | undefined {
  const now = startupPhaseNow();
  return now !== null && origin !== null && now >= origin ? now - origin : undefined;
}
function incomplete(): void {
  try {
    broken = true;
    spans.clear();
    if (!role || role === "cli" || finalQueued) return;
    finalQueued = true;
    const line = Buffer.from(
      STARTUP_PHASE_PREFIX +
        JSON.stringify({
          version: 1,
          pid: actualPid,
          seq: ++seq,
          role,
          phase: "verify.total",
          edge: "point",
          outcome: "incomplete",
        }) +
        "\n",
    );
    enqueue(line, true);
  } catch {
    broken = true;
  }
}
function emit(event: Record<string, unknown>, final = false): void {
  const row: Record<string, unknown> = {
    version: 1,
    pid: actualPid,
    seq: ++seq,
    role,
    elapsedUs: elapsed(),
    ...event,
  };
  if (broken && final) row.outcome = "incomplete";
  if (broken && !final) {
    incomplete();
    return;
  }
  let line = Buffer.from(STARTUP_PHASE_PREFIX + JSON.stringify(row) + "\n");
  if (role === "cli" && final && line.length > 256) {
    line = Buffer.from(
      STARTUP_PHASE_PREFIX +
        JSON.stringify({
          version: 1,
          pid: actualPid,
          seq,
          role,
          phase: "cli.total",
          edge: "end",
          outcome: "incomplete",
        }) +
        "\n",
    );
  }
  if (!enqueue(line, final)) incomplete();
}
function optionalFields(row: Record<string, unknown>): boolean {
  for (const key of ["elapsedUs", "span", "cycle", "durationUs", "builtinOrdinal", "value"])
    if (row[key] !== undefined && !integer(row[key])) return false;
  if (row.builtinOrdinal !== undefined && (row.builtinOrdinal as number) > 13) return false;
  if (
    row.relation !== undefined &&
    (row.phase !== "owner.refresh" || !["new", "join"].includes(row.relation as string))
  )
    return false;
  return row.outcome === undefined || ["ok", "error", "incomplete"].includes(row.outcome as string);
}
function valid(event: StartupPhaseEvent): boolean {
  if (
    !event ||
    Object.keys(event).some((key) => !eventKeys.has(key)) ||
    !phases.includes(event.phase) ||
    !["begin", "end", "point", "add"].includes(event.edge)
  )
    return false;
  if (!optionalFields({ ...event })) return false;
  if (event.edge === "add") return counters.includes(event.counter!) && integer(event.value);
  return event.counter === undefined && event.value === undefined;
}
function add(event: StartupPhaseEvent): void {
  const counter = event.counter!;
  const value = event.value!;
  const key = `${event.phase}:${event.span ?? 0}`;
  const target = spans.get(key);
  if (!target) {
    incomplete();
    return;
  }
  const current = target[counter] ?? 0;
  const next =
    counter === "maxWidth" || counter === "maxReservedBytes"
      ? Math.max(current, value)
      : current + value;
  if (!integer(next)) {
    incomplete();
    return;
  }
  target[counter] = next;
  if (counter === "readBytes" || counter === "declaredBytes" || counter === "files") {
    const total = totals[counter] + value;
    if (!integer(total)) {
      incomplete();
      return;
    }
    totals[counter] = total;
  }
}
function cliSummary(event: StartupPhaseEvent): boolean {
  if (role !== "cli" || event.phase !== "cli.total" || event.edge !== "end") return false;
  if (!records) {
    emit(
      {
        phase: "cli.total",
        edge: "end",
        durationUs: event.durationUs,
        outcome: broken ? "incomplete" : event.outcome,
        ...totals,
      },
      true,
    );
  }
  return true;
}
function spanEvent(event: StartupPhaseEvent): void {
  const key = `${event.phase}:${event.span ?? 0}`;
  if (event.edge === "begin") {
    if (spans.size >= 64 || spans.has(key)) {
      incomplete();
      return;
    }
    spans.set(key, {});
  }
  if (event.edge === "add") {
    add(event);
    return;
  }
  if (event.edge === "end") {
    const counts = spans.get(key);
    if (!counts) {
      incomplete();
      return;
    }
    spans.delete(key);
    if (role !== "cli") {
      for (const [counter, value] of Object.entries(counts))
        emit({ phase: event.phase, edge: "count", span: event.span, counter, value });
    }
  }
  if (role !== "cli") emit({ ...event });
}
/** Fixed trusted-source DATA; never an execution, receipt, freshness or quiet decision. */
export function recordStartupPhase(event: StartupPhaseEvent): void {
  try {
    if (!role) return;
    if (!valid(event)) {
      incomplete();
      return;
    }
    if (cliSummary(event)) return;
    if (broken) {
      incomplete();
      return;
    }
    spanEvent(event);
  } catch {
    incomplete();
  }
}

function terminalRow(raw: Buffer, actualChildPid: number): boolean {
  if (
    raw.length > 256 ||
    raw.at(-1) !== 10 ||
    !raw.toString("utf8").startsWith(STARTUP_PHASE_PREFIX)
  )
    return false;
  const row = JSON.parse(raw.subarray(Buffer.byteLength(STARTUP_PHASE_PREFIX)).toString("utf8"));
  if (
    !row ||
    Object.keys(row).some((key) => !rowKeys.has(key)) ||
    row.version !== 1 ||
    row.pid !== actualChildPid ||
    row.role !== "terminal" ||
    !integer(row.seq) ||
    !row.seq ||
    !phases.includes(row.phase) ||
    !["begin", "end", "point", "count"].includes(row.edge)
  )
    return false;
  if (!optionalFields(row)) return false;
  if (row.edge === "count") return counters.includes(row.counter) && integer(row.value);
  return row.counter === undefined && row.value === undefined;
}
/** Existing terminal stderr PIPE DATA only; caller passes the original actual child.pid. */
export function forwardTerminalStartupPhase(line: Uint8Array, actualChildPid: number): void {
  try {
    if (role !== "daemon" || broken) return;
    if (!(line instanceof Uint8Array) || line.byteLength > 256) {
      incomplete();
      return;
    }
    const raw = Buffer.from(line);
    if (!terminalRow(raw, actualChildPid)) {
      incomplete();
      return;
    }
    if (!enqueue(raw, false)) incomplete();
  } catch {
    incomplete();
  }
}
