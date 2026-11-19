import {
  capturePluginActivityOrigin,
  type PluginActivityOrigin,
} from "@getpaseo/plugin/internal/activity";
import { assertHeldPluginOperation } from "../maintenance-reservation.js";
import type { PluginHeldOperation } from "./held-operation.js";
import type { NativePluginAdmission } from "./maintenance.js";
import { pluginExecutionKey, type PluginExecutionRoot } from "./execution-roots.js";

/** Separate from reply correlation: only execution-owner settlement releases native work. */
export class PluginExecutionOwner {
  private expectedHeldTermination = false;
  private readonly releases = new Map<
    string,
    { release: () => void; origin?: PluginActivityOrigin }
  >();
  constructor(
    readonly instanceId: string,
    private readonly native: NativePluginAdmission | undefined,
    private readonly admissionClosed: () => boolean,
    private readonly unknown: () => void,
    private readonly changed: () => void = () => {},
  ) {}
  admit(message: PluginExecutionRoot): void {
    if (this.admissionClosed()) throw new Error("Plugin maintenance admission is closed");
    const key = pluginExecutionKey(message);
    if (this.releases.has(key)) throw new Error("Duplicate plugin execution identity");
    const origin = message.type === "hook" ? capturePluginActivityOrigin(key, message) : undefined;
    const release = this.native?.enterWork() ?? (() => {});
    this.releases.set(key, { release, origin });
    this.changed();
  }
  runAdmitted<T>(message: PluginExecutionRoot, operation: () => T): T {
    const release = this.releases.get(pluginExecutionKey(message))?.release;
    if (!release) throw new Error("Missing admitted plugin execution root");
    if (this.native?.runAdmittedWork) return this.native.runAdmittedWork(release, operation);
    return operation();
  }
  /** Read only while the ORIGINAL native request lease is still live. */
  readAdmittedOrigin(instanceId: string, key: string): PluginActivityOrigin | undefined {
    if (instanceId !== this.instanceId) throw new Error("Plugin execution incarnation mismatch");
    return this.releases.get(key)?.origin;
  }
  settled(instanceId: string, key: string): void {
    if (instanceId !== this.instanceId) {
      this.markUnknown();
      return;
    }
    const release = this.releases.get(key)?.release;
    if (!release) return;
    this.releases.delete(key);
    this.changed();
    release();
  }
  markUnknown(): void {
    this.changed();
    this.unknown();
    this.native?.holdForUnknownWork();
  }
  expectHeldTermination(held: PluginHeldOperation, instanceId: string): void {
    assertHeldPluginOperation(held.scope, held.claim);
    if (instanceId !== this.instanceId || this.releases.size)
      throw new Error("Cannot retire a different or active plugin execution owner");
    this.expectedHeldTermination = true;
  }
  terminated(): void {
    if (this.releases.size || (this.admissionClosed() && !this.expectedHeldTermination))
      this.markUnknown();
  }
  busy(): boolean {
    return this.releases.size > 0;
  }
}
