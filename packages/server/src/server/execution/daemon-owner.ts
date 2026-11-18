import { installQualifiedPluginHelperGuard } from "./plugin-helper-admission.js";
import { mkdir, realpath } from "node:fs/promises";
import {
  readTerminalWorkerRecord,
  terminalWorkerDirectory,
  terminalWorkerRecordPath,
  TERMINAL_WORKER_MARKER_ARG,
} from "../../terminal/terminal-worker-record.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Worker, MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { qualifiedBindings } from "./qualified-bindings.js";
import { observeLinuxProcess, verifyEnclosingProcess, unsupported } from "./daemon-verifier.js";
import type { QualifiedExecutionBinding } from "./types.js";
import type { QualifiedDaemonOwner, OwnedObservation } from "./daemon-types.js";
export type { QualifiedDaemonOwner } from "./daemon-types.js";
declare const __QUALIFIED_DAEMON_ENTRY__: boolean;
const owners = new WeakSet<object>();
const bindings = new WeakSet<object>();
let instance: Promise<QualifiedDaemonOwner> | null = null;
let executingOwner: QualifiedDaemonOwner | null = null;
interface HandleRecord {
  kind: "plugin-child" | "compiler" | "terminal-worker";
  incarnation: string;
  alive: boolean;
}
interface ObservationPort {
  on(event: "message", listener: (value: unknown) => void): void;
  off(event: "message", listener: (value: unknown) => void): void;
  postMessage(message: { type: string; challenge: string }): void;
}
function exchange(port: ObservationPort, challenge: string): Promise<OwnedObservation> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Owned execution observation timeout"));
    }, 10000);
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Reflect.get(raw, "challenge") !== challenge) return;
      cleanup();
      try {
        acceptReply?.(raw as OwnedObservation);
        resolve(raw as OwnedObservation);
      } catch (error) {
        reject(error);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      port.off("message", receive);
    }
    port.on("message", receive);
    port.postMessage({ type: "qualified.execution.challenge", challenge });
  });
}
function childPort(child: ChildProcess): ObservationPort {
  return {
    on: (event, listener) => {
      child.prependListener(event, listener);
    },
    off: (event, listener) => {
      child.off(event, listener);
    },
    postMessage: (message) => {
      child.send(message);
    },
  };
}
async function produce(): Promise<QualifiedDaemonOwner> {
  if (typeof __QUALIFIED_DAEMON_ENTRY__ === "undefined" || !__QUALIFIED_DAEMON_ENTRY__)
    return unsupported();
  const file = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const root = path.dirname(file);
  const initial = await verifyEnclosingProcess(root);
  if (
    path.basename(file) !== "daemon.mjs" ||
    (await realpath(process.argv[1] ?? "")) !== path.join(root, "role.cjs")
  )
    return unsupported();
  const namespaces = new Map(Object.entries(qualifiedBindings));
  const incarnation = `${initial.observed.bootId}:${initial.observed.birth}:${randomUUID()}`;
  const handles = new WeakMap<object, HandleRecord>();
  const observers = new Map<object, () => Promise<void>>();
  const terminals = new WeakMap<object, { child: ChildProcess; incarnation: string }>();
  let fresh = true;
  let failed = false;
  let pending: Promise<void> | null = null;
  const evidence = {
    schemaVersion: 1,
    role: "daemon",
    distributionBuildId: initial.manifest.distributionBuildId,
    qualificationManifestSha256: initial.manifestSha256,
    process: { ...initial.observed, processStartToken: incarnation },
    bindings: Object.keys(qualifiedBindings).sort(),
  };
  const evidenceDigest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  function assertFresh(): void {
    if (!fresh || failed || pending) return unsupported();
    for (const [key, namespace] of namespaces)
      if (qualifiedBindings[key] !== namespace) return unsupported();
  }
  const binding: QualifiedExecutionBinding = Object.freeze({
    expectedClosure: initial.manifestSha256,
    expectedIncarnation: incarnation,
    capability: Object.freeze({
      evidenceDigest,
      assertQualifiedExecution(expectedClosure: unknown, expectedIncarnation: unknown): void {
        assertFresh();
        if (expectedClosure !== initial.manifestSha256 || expectedIncarnation !== incarnation)
          return unsupported();
      },
    }),
  });
  function assertOwnedExecutionHandle(
    handle: ChildProcess | Worker,
    kind: "plugin-child" | "compiler" | "terminal-worker",
    expectedIncarnation: string,
  ): void {
    assertFresh();
    const record = handles.get(handle);
    if (handle instanceof Worker) {
      if (handle.threadId < 0) return unsupported();
    } else if (handle.exitCode !== null || handle.signalCode !== null || !handle.connected) {
      return unsupported();
    }
    if (
      !record ||
      !record.alive ||
      record.kind !== kind ||
      record.incarnation !== expectedIncarnation
    )
      return unsupported();
  }
  async function refresh(): Promise<void> {
    if (failed) return unsupported();
    if (pending) return pending;
    fresh = false;
    pending = (async () => {
      try {
        const current = await verifyEnclosingProcess(root);
        if (
          current.manifestSha256 !== initial.manifestSha256 ||
          current.observed.birth !== initial.observed.birth ||
          current.observed.image !== initial.observed.image ||
          JSON.stringify(current.closure) !== JSON.stringify(initial.closure)
        )
          return unsupported();
        for (const observe of observers.values()) await observe();
        fresh = true;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }
  function accept(
    observed: OwnedObservation,
    challenge: string,
    kind: HandleRecord["kind"],
    actual: { pid: number },
    expectedIncarnation?: string,
  ): void {
    if (
      observed.challenge !== challenge ||
      observed.pid !== actual.pid ||
      observed.manifestSha256 !== initial.manifestSha256 ||
      observed.distributionBuildId !== initial.manifest.distributionBuildId ||
      typeof observed.incarnation !== "string" ||
      (expectedIncarnation && observed.incarnation !== expectedIncarnation)
    )
      return unsupported();
    if (kind === "compiler" && !Number.isInteger(observed.threadId)) return unsupported();
  }
  const owner = Object.freeze<QualifiedDaemonOwner>({
    binding,
    evidenceDigest,
    root,
    closure: initial.closure,
    assertFresh,
    refresh,
    assertOwnedExecutionHandle,
    assertQualification(expected, expectedIncarnation): void {
      assertFresh();
      if (
        expectedIncarnation !== incarnation ||
        expected.runtimeClosureSha256 !== initial.closure.runtimeClosureSha256 ||
        expected.helperClosureSha256 !== initial.closure.helperClosureSha256 ||
        expected.qualificationSha256 !== initial.closure.qualificationSha256
      )
        return unsupported();
    },
    async launchPluginChild() {
      await refresh();
      assertFresh();
      const child = spawn(
        path.join(root, "runtime/node"),
        [path.join(root, "plugin-child-entry.mjs")],
        { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const port = childPort(child);
      const consumedReplies = new WeakSet<object>();
      const challenge = randomUUID();
      try {
        const observed = await exchange(port, challenge);
        const actual = await observeLinuxProcess(child.pid!);
        accept(observed, challenge, "plugin-child", actual);
        if (actual.executable !== path.join(root, "runtime/node")) return unsupported();
        const record: HandleRecord = {
          kind: "plugin-child",
          incarnation: observed.incarnation,
          alive: true,
        };
        await refresh();
        assertFresh();
        if (child.exitCode !== null || child.signalCode !== null || !child.connected)
          return unsupported();
        handles.set(child, record);
        const verifyReply = (reply: OwnedObservation): void => {
          accept(reply, reply.challenge, "plugin-child", actual, record.incarnation);
          consumedReplies.add(reply);
        };
        observers.set(child, async () => {
          const nonce = randomUUID();
          const result = await exchange(port, nonce, verifyReply);
          const now = await observeLinuxProcess(child.pid!);
          if (now.birth !== actual.birth || now.image !== actual.image) return unsupported();
          accept(result, nonce, "plugin-child", now, record.incarnation);
        });
        child.once("close", () => {
          record.alive = false;
          observers.delete(child);
        });
        return Object.freeze({
          child,
          consumeObservation(raw: unknown): boolean {
            if (!raw || typeof raw !== "object" || !consumedReplies.has(raw)) return false;
            consumedReplies.delete(raw);
            return true;
          },
          closure: initial.closure,
          incarnation: record.incarnation,
          assertFresh: () => assertOwnedExecutionHandle(child, "plugin-child", record.incarnation),
          async challenge() {
            assertOwnedExecutionHandle(child, "plugin-child", record.incarnation);
            const nonce = randomUUID();
            const result = await exchange(port, nonce, verifyReply);
            const now = await observeLinuxProcess(child.pid!);
            if (now.birth !== actual.birth || now.image !== actual.image) return unsupported();
            accept(result, nonce, "plugin-child", now, record.incarnation);
            return result;
          },
        });
      } catch (error) {
        failed = true;
        child.kill();
        throw error;
      }
    },
    assertOwnedTerminalWorker(record: unknown): void {
      if (!record || typeof record !== "object") return unsupported();
      const owned = terminals.get(record);
      if (!owned) return unsupported();
      assertOwnedExecutionHandle(owned.child, "terminal-worker", owned.incarnation);
    },
    async launchTerminalWorker(input) {
      await refresh();
      assertFresh();
      await mkdir(terminalWorkerDirectory(input.paseoHome), { recursive: true, mode: 0o700 });
      const recordId = randomUUID();
      const child = spawn(
        path.join(root, "runtime/node"),
        [
          path.join(root, "terminal-entry.mjs"),
          TERMINAL_WORKER_MARKER_ARG,
          recordId,
          "--paseo-home",
          input.paseoHome,
          "--paseo-version",
          input.paseoVersion,
          "--runtime",
          root,
        ],
        { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"] },
      );
      try {
        const ready = await new Promise<string>((resolve, reject) => {
          const stream = child.stdio[3];
          if (!stream || !("on" in stream)) {
            reject(new Error("Missing owned terminal ready pipe"));
            return;
          }
          let buffer = "";
          const timer = setTimeout(
            () => reject(new Error("Owned terminal readiness timeout")),
            input.timeoutMs ?? 20000,
          );
          stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.length > 8192) {
              clearTimeout(timer);
              reject(new Error("Invalid terminal readiness"));
            }
            const newline = buffer.indexOf("\n");
            if (newline !== -1) {
              clearTimeout(timer);
              const line = buffer.slice(0, newline);
              if (!line.startsWith("ready ")) reject(new Error("Terminal readiness rejected"));
              else resolve(line.slice(6));
            }
          });
          child.once("error", reject);
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Terminal exited before readiness"));
          });
        });
        const nonce = randomUUID();
        const observation = await exchange(childPort(child), nonce);
        const actual = await observeLinuxProcess(child.pid!);
        accept(observation, nonce, "terminal-worker", actual);
        if (actual.executable !== path.join(root, "runtime/node")) return unsupported();
        const recordPath = terminalWorkerRecordPath(input.paseoHome, child.pid!);
        const record = await readTerminalWorkerRecord(recordPath);
        if (
          record.pid !== child.pid ||
          record.recordId !== recordId ||
          record.socketPath !== ready ||
          record.runtime !== root
        )
          return unsupported();
        const owned: HandleRecord = {
          kind: "terminal-worker",
          incarnation: observation.incarnation,
          alive: true,
        };
        await refresh();
        assertFresh();
        if (child.exitCode !== null || child.signalCode !== null || !child.connected)
          return unsupported();
        handles.set(child, owned);
        terminals.set(record, { child, incarnation: owned.incarnation });
        observers.set(child, async () => {
          const challenge = randomUUID();
          const reply = await exchange(childPort(child), challenge);
          const now = await observeLinuxProcess(child.pid!);
          if (now.birth !== actual.birth || now.image !== actual.image) return unsupported();
          accept(reply, challenge, "terminal-worker", now, owned.incarnation);
        });
        child.once("close", () => {
          owned.alive = false;
          observers.delete(child);
        });
        return { record, recordPath };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async createCompilerWorker() {
      await refresh();
      assertFresh();
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(path.join(root, "compiler-entry.mjs"), {
        execArgv: [],
        env: { PATH: "/usr/bin:/bin", ESBUILD_BINARY_PATH: path.join(root, "runtime/esbuild") },
        workerData: { qualificationPort: port2 },
        transferList: [port2],
      });
      port1.on("message", (raw: unknown) => {
        if (
          raw &&
          typeof raw === "object" &&
          Reflect.get(raw, "type") === "qualified.execution.unknown"
        )
          failed = true;
      });
      const nonce = randomUUID();
      try {
        const observed = await exchange(port1, nonce);
        accept(observed, nonce, "compiler", { pid: process.pid });
        if (observed.threadId !== worker.threadId) return unsupported();
        const record: HandleRecord = {
          kind: "compiler",
          incarnation: observed.incarnation,
          alive: true,
        };
        await refresh();
        assertFresh();
        if (worker.threadId < 0) return unsupported();
        handles.set(worker, record);
        observers.set(worker, async () => {
          const challenge = randomUUID();
          const reply = await exchange(port1, challenge);
          accept(reply, challenge, "compiler", { pid: process.pid }, record.incarnation);
          if (reply.threadId !== worker.threadId) return unsupported();
        });
        worker.once("exit", () => {
          record.alive = false;
          port1.close();
          observers.delete(worker);
        });
        return Object.freeze({
          worker,
          closure: initial.closure,
          incarnation: record.incarnation,
          assertFresh: () => assertOwnedExecutionHandle(worker, "compiler", record.incarnation),
          close(): Promise<void> {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                failed = true;
                reject(new Error("Compiler helper settlement unknown"));
              }, 10000);
              worker.once("exit", () => {
                clearTimeout(timer);
                if (failed) reject(new Error("Compiler retirement uncertain"));
                else resolve();
              });
              port1.postMessage({ type: "qualified.execution.stop" });
            });
          },
        });
      } catch (error) {
        failed = true;
        port1.close();
        await worker.terminate();
        throw error;
      }
    },
  });
  installQualifiedPluginHelperGuard();
  owners.add(owner);
  bindings.add(binding);
  executingOwner = owner;
  return owner;
}
export function getQualifiedDaemonOwner(): Promise<QualifiedDaemonOwner> {
  return (instance ??= produce());
}
export function isQualifiedDaemonOwner(value: unknown): value is QualifiedDaemonOwner {
  if (!value || typeof value !== "object" || !owners.has(value)) return false;
  try {
    (value as QualifiedDaemonOwner).assertFresh();
    return true;
  } catch {
    return false;
  }
}
export function isQualifiedDaemonBinding(value: unknown): value is QualifiedExecutionBinding {
  if (!value || typeof value !== "object" || !bindings.has(value)) return false;
  try {
    const binding = value as QualifiedExecutionBinding;
    binding.capability.assertQualifiedExecution(
      binding.expectedClosure,
      binding.expectedIncarnation,
    );
    return true;
  } catch {
    return false;
  }
}

/** Same sealed daemon module only; never synthesizes a plugin-host role. */
export function assertQualifiedDaemonEvaluation(): void {
  if (!executingOwner || !owners.has(executingOwner)) return unsupported();
  executingOwner.assertFresh();
}
