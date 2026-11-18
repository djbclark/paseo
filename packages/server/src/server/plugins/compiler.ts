import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isQualifiedDaemonOwner } from "../execution/qualified-host.js";
import type {
  QualifiedDaemonOwner,
  QualifiedOwnedCompiler,
  QualifiedClosure,
} from "../execution/daemon-types.js";
import { assertPluginHeldOperation, type PluginHeldOperation } from "./held-operation.js";
import type { NativePluginAdmission } from "./maintenance.js";
import { hashPluginSnapshot } from "./activation-policy.js";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import pLimit from "p-limit";
import { ZodError } from "zod";
import type * as build from "./compiler-build.js";
import type { PluginManifest } from "./manifest.js";
import type { CompilerReply } from "./compiler-worker.js";

export {
  SERVER_HOST_MODULES,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler-esbuild.js";

export type CompilerTask =
  | { kind: "entries"; entries: Parameters<typeof build.compilePlugin>[0] }
  | { kind: "directory"; directory: string; version: string; builtinId?: string }
  | {
      kind: "prepare";
      directory: string;
      commands: PluginManifest["build"];
      environment: NodeJS.ProcessEnv;
    };

interface TaskResult {
  entries: Awaited<ReturnType<typeof build.compilePlugin>>;
  directory: Awaited<ReturnType<typeof build.compileDirectoryPlugin>>;
  prepare: void;
}

const IDLE_TIMEOUT_MS = 1_000;
const source = import.meta.url.endsWith(".ts");
const workerUrl = new URL(
  source ? "./compiler-worker.ts" : "./compiler-worker.js",
  import.meta.url,
);
// Resolve the development loader once at module initialization, never during a
// compile request. Packaged workers execute ordinary JavaScript without tsx.
const workerEntrypoint = source
  ? `import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
  : workerUrl;

// Reuse the isolate during a build batch (notably daemon bootstrap), then release
// TypeScript's heap when idle. Only this owner admits work or stops the worker.
interface QualifiedCompilerContext {
  readonly owner: QualifiedDaemonOwner;
  readonly native: NativePluginAdmission;
  readonly held: PluginHeldOperation;
  readonly snapshotRoot: string;
}

class PluginCompiler {
  private ownedWorker: QualifiedOwnedCompiler | null = null;
  private ownedIdentity: {
    threadId: number;
    incarnation: string;
    closure: Readonly<QualifiedClosure>;
  } | null = null;
  getQualifiedWorkerIdentity() {
    return this.ownedIdentity;
  }
  constructor(private readonly qualified?: QualifiedCompilerContext) {}
  private readonly queue = pLimit(1);
  private worker: Worker | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<unknown> = Promise.resolve();

  run<T extends CompilerTask>(
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    return this.queue(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await this.stopping;
      const worker = this.worker ?? (await this.startWorker());
      worker.ref();
      try {
        return await this.request<T>(worker, task, onLog);
      } finally {
        if (this.qualified) {
          this.stopWorker(worker);
          await this.stopping;
        } else if (this.worker === worker) {
          worker.unref();
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        } else {
          await this.stopping;
        }
      }
    });
  }

  private async startWorker(): Promise<Worker> {
    const context = this.qualified;
    if (context) {
      if (!isQualifiedDaemonOwner(context.owner)) throw new Error("Unqualified compiler owner");
      assertPluginHeldOperation(context.held, context.held.claim.pluginId, context.held.claim.path);
      await context.owner.refresh();
      const owned = await context.owner.createCompilerWorker();
      this.ownedWorker = owned;
      this.worker = owned.worker;
      try {
        context.owner.assertOwnedExecutionHandle(owned.worker, "compiler", owned.incarnation);
        owned.assertFresh();
      } catch (error) {
        context.native.holdForUnknownWork();
        this.stopWorker(owned.worker);
        await this.stopping;
        throw error;
      }
      this.ownedIdentity = Object.freeze({
        threadId: owned.worker.threadId,
        incarnation: owned.incarnation,
        closure: Object.freeze({ ...owned.closure }),
      });
      qualifiedObservationEpoch++;
    }
    const worker =
      this.ownedWorker?.worker ?? new Worker(workerEntrypoint, { eval: source, execArgv: [] });
    this.worker = worker;
    // Keep error/exit ownership while idle too. The next caller gets a fresh
    // isolate after a crash; author build commands are never retried.
    worker.on("error", () => this.stopWorker(worker));
    worker.on("exit", () => {
      if (this.worker === worker) this.stopWorker(worker);
    });
    return worker;
  }

  private stopWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const owned = this.ownedWorker;
    this.ownedWorker = null;
    if (owned) {
      // A control timeout/abnormal exit does not settle actual helper work.
      // Keep the enclosing native scope lease until the private producer ACK
      // and actual Worker exit resolve this independent settlement promise.
      this.stopping = owned
        .close()
        .catch(() => {
          this.qualified?.native.holdForUnknownWork();
        })
        .then(() => owned.settled);
    } else this.stopping = worker.terminate();
  }

  private async request<T extends CompilerTask>(
    worker: Worker,
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    let onMessage: (reply: CompilerReply) => void;
    let onError: (error: Error) => void;
    let onExit: (code: number) => void;
    try {
      return await new Promise<TaskResult[T["kind"]]>((resolve, reject) => {
        onError = reject;
        onExit = (code) => reject(new Error(`Plugin compiler worker exited (code ${code})`));
        onMessage = (reply) => {
          if (reply.kind === "log") {
            onLog?.(reply.data, reply.message);
          } else if (reply.kind === "result") {
            resolve(reply.value as TaskResult[T["kind"]]);
          } else {
            const error = reply.issues ? new ZodError(reply.issues) : reply.error;
            Object.assign(error, reply.properties);
            if (reply.errors) Object.assign(error, { errors: reply.errors });
            if (reply.warnings) Object.assign(error, { warnings: reply.warnings });
            // All target work has settled before an error reply. Retire this
            // isolate before another request can enter it.
            this.stopWorker(worker);
            reject(error);
          }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        worker.postMessage(task, []);
      });
    } finally {
      worker.off("message", onMessage!);
      worker.off("error", onError!);
      worker.off("exit", onExit!);
    }
  }
}

const compiler = new PluginCompiler();

export function runCompilerTask<T extends CompilerTask>(
  task: T,
  onLog?: (data: Record<string, unknown>, message: string) => void,
): Promise<TaskResult[T["kind"]]> {
  return compiler.run(task, onLog);
}

export function compilePlugin(entries: Parameters<typeof build.compilePlugin>[0]) {
  return runCompilerTask({ kind: "entries", entries });
}

export function compileDirectoryPlugin(directory: string, version: string, builtinId?: string) {
  return runCompilerTask({ kind: "directory", directory, version, builtinId });
}

export interface QualifiedCompilerRunObservation {
  readonly threadId: number;
  readonly incarnation: string;
  readonly sourceDirectory: string;
  readonly snapshotRoot: string;
  readonly snapshotSha256: string;
  readonly serverBundleBase64: string;
  readonly serverBundleSha256: string;
  readonly serverBundleByteLength: number;
  readonly clientBundleBase64: string | null;
  readonly clientBundleSha256: string | null;
  readonly closure: Readonly<QualifiedClosure>;
  readonly settled: true;
  readonly trigger: Pick<
    PluginHeldOperation["claim"],
    "generation" | "transactionId" | "operation" | "pluginId" | "expectedGeneration"
  >;
}
const qualifiedRuns = new WeakMap<
  QualifiedDaemonOwner,
  readonly QualifiedCompilerRunObservation[]
>();
let qualifiedObservationEpoch = 0;

export function getQualifiedCompilerObservationEpoch(owner: QualifiedDaemonOwner): number | null {
  if (!isQualifiedDaemonOwner(owner)) return null;
  owner.assertFresh();
  return qualifiedObservationEpoch;
}
export function getQualifiedCompilerObservations(
  owner: QualifiedDaemonOwner,
): readonly QualifiedCompilerRunObservation[] | null {
  if (!isQualifiedDaemonOwner(owner)) return null;
  owner.assertFresh();
  return qualifiedRuns.get(owner) ?? null;
}

// This finite directory-only entry has no build-command task surface. The
// private native scope remains leased through actual compiler/helper settlement.
export async function compileQualifiedDirectoryPlugin(
  directory: string,
  version: string,
  context: QualifiedCompilerContext,
): Promise<TaskResult["directory"]> {
  const { owner, native, held, snapshotRoot } = context;
  if (!isQualifiedDaemonOwner(owner) || !native.runHeldOperation)
    throw new Error("Qualified compiler admission unavailable");
  assertPluginHeldOperation(held, held.claim.pluginId, directory);
  if ((await realpath(directory)) !== directory || (await realpath(snapshotRoot)) !== snapshotRoot)
    throw new Error("Qualified compilation requires canonical immutable paths");
  const relative = path.relative(snapshotRoot, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Compiler source is outside its qualified snapshot");
  return native.runHeldOperation(held.scope, held.claim, async () => {
    const snapshotSha256 = await hashPluginSnapshot(snapshotRoot);
    if (snapshotSha256 !== held.claim.snapshotSha256) throw new Error("Compiler snapshot mismatch");
    const instance = new PluginCompiler(context);
    const result = await instance.run({ kind: "directory", directory, version });
    if ((await hashPluginSnapshot(snapshotRoot)) !== snapshotSha256)
      throw new Error("Compiler snapshot changed");
    assertPluginHeldOperation(held, held.claim.pluginId, directory);
    await owner.refresh();
    if (!result.serverBundle) throw new Error("Qualified compilation requires server output");
    const identity = instance.getQualifiedWorkerIdentity();
    if (!identity) throw new Error("Missing actual owned compiler identity");
    const serverBytes = Buffer.from(result.serverBundle, "utf8");
    const clientBytes =
      result.clientBundle === null ? null : Buffer.from(result.clientBundle, "utf8");
    if (createHash("sha256").update(serverBytes).digest("hex") !== held.claim.serverBundleSha256)
      throw new Error("Qualified compiler output differs from authorized artifact");
    const observation: QualifiedCompilerRunObservation = Object.freeze({
      ...identity,
      sourceDirectory: directory,
      snapshotRoot,
      snapshotSha256,
      serverBundleBase64: serverBytes.toString("base64"),
      serverBundleSha256: createHash("sha256").update(serverBytes).digest("hex"),
      serverBundleByteLength: serverBytes.byteLength,
      clientBundleBase64: clientBytes?.toString("base64") ?? null,
      clientBundleSha256: clientBytes
        ? createHash("sha256").update(clientBytes).digest("hex")
        : null,
      settled: true,
      trigger: Object.freeze({
        generation: held.claim.generation,
        transactionId: held.claim.transactionId,
        operation: held.claim.operation,
        pluginId: held.claim.pluginId,
        expectedGeneration: held.claim.expectedGeneration,
      }),
    });
    qualifiedRuns.set(
      owner,
      Object.freeze([...(qualifiedRuns.get(owner) ?? []).slice(-3), observation]),
    );
    qualifiedObservationEpoch++;
    return result;
  });
}
