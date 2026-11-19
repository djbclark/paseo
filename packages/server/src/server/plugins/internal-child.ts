import type { PluginActivityOwner } from "@getpaseo/plugin/internal/activity";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createPluginWorker,
  type PluginWorkerChannel,
  type PluginContributionLoader,
} from "./plugin-process.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

export class InternalPluginChild extends EventEmitter {
  connected = true;
  killed = false;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly worker: ReturnType<typeof createPluginWorker>;
  private readonly workerMessages = new Set<(message: PluginProcessRequest) => void>();
  private closing: Promise<void> | null = null;

  constructor(loadContribution: PluginContributionLoader) {
    super();
    const channel: PluginWorkerChannel = {
      send: (message: PluginProcessMessage, callback?: () => void) => {
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (this.connected) this.emit("message", copy);
          callback?.();
        });
      },
      onMessage: (handler) => {
        this.workerMessages.add(handler);
        return () => this.workerMessages.delete(handler);
      },
      disconnect: () => this.disconnect(),
    };
    this.worker = createPluginWorker({ channel, loadContribution });
    internalPluginExecutions.set(
      this,
      Object.freeze({ workerIdentity: this.worker, activityOwner: this.worker.activityOwner }),
    );
  }

  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback?.(new Error("Plugin child is disconnected"));
      return false;
    }
    const copy = structuredClone(message);
    queueMicrotask(() => {
      for (const handler of this.workerMessages) handler(copy);
      callback?.(null);
    });
    return true;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.disconnect();
    return true;
  }

  disconnect(): void {
    void this.retire().catch((error) => {
      this.worker.activityOwner.markUnknown();
      this.stderr.write(`Plugin shutdown failed: ${String(error)}\n`);
    });
  }
  /** Actual cleanup/drain completion. Rejection never emits a successful close. */
  retire(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve()
      .then(() => this.worker.shutdown())
      .then(() => {
        this.connected = false;
        this.stdout.end();
        this.stderr.end();
        this.emit("close", 0, null);
        return undefined;
      });
    return this.closing;
  }
}

export interface InternalPluginExecutionBinding {
  readonly workerIdentity: object;
  readonly activityOwner: PluginActivityOwner;
}
const internalPluginExecutions = new WeakMap<object, InternalPluginExecutionBinding>();
/** Actual original constructor association only; this observation grants no qualification. */
export function readInternalPluginExecution(
  instance: unknown,
): InternalPluginExecutionBinding | undefined {
  if (!instance || typeof instance !== "object") return undefined;
  return internalPluginExecutions.get(instance);
}
