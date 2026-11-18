import type { NativePluginAdmission } from "./maintenance.js";
import { pluginExecutionKey, type PluginExecutionRoot } from "./execution-roots.js";

/** Separate from reply correlation: only execution-owner settlement releases native work. */
export class PluginExecutionOwner {
  private readonly releases = new Map<string, () => void>();
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
    const release = this.native?.enterWork() ?? (() => {});
    this.releases.set(key, release);
    this.changed();
  }
  settled(instanceId: string, key: string): void {
    if (instanceId !== this.instanceId) {
      this.markUnknown();
      return;
    }
    const release = this.releases.get(key);
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
  terminated(): void {
    if (this.releases.size || this.admissionClosed()) this.markUnknown();
  }
  busy(): boolean {
    return this.releases.size > 0;
  }
}
