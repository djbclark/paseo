import type { PluginListItem } from "./messages.js";
/** Native-only immutable claim. No bearer or private scope crosses plugin IPC. */
export interface HeldPluginOperationClaim {
  readonly generation: number;
  readonly transactionId: string;
  readonly operation: "replace" | "recover" | "verify";
  readonly pluginId: string;
  readonly path: string;
  readonly expectedPath: string;
  readonly expectedGeneration: number;
  readonly snapshotSha256: string;
  readonly serverBundleSha256: string;
}

declare const heldOperationBrand: unique symbol;
export interface HeldPluginOperationScope {
  readonly [heldOperationBrand]: true;
}

export interface HeldPluginOperationResult { plugin: PluginListItem; nativeGeneration: number; }
export type HeldPluginOperationDriver = (claim: HeldPluginOperationClaim, scope: HeldPluginOperationScope) => Promise<HeldPluginOperationResult>;
export function heldPluginOperationDriver(service: object): HeldPluginOperationDriver | undefined {
  const method = (service as { heldPluginOperation?: HeldPluginOperationDriver }).heldPluginOperation;
  return typeof method === "function" ? method.bind(service) : undefined;
}

/** The trusted service still must return the exact requested loaded target. */
export function assertHeldPluginOperationResult(claim: HeldPluginOperationClaim, result: HeldPluginOperationResult): void {
  const plugin = result.plugin;
  const loaded = plugin.loaded;
  if (!Number.isSafeInteger(result.nativeGeneration) || result.nativeGeneration < claim.expectedGeneration || plugin.id !== claim.pluginId || plugin.path !== claim.path || !plugin.enabled || plugin.status !== "running") throw new Error("Invalid held plugin operation result");
  if (!loaded || loaded.pluginId !== claim.pluginId || loaded.sourcePath !== claim.path || loaded.snapshotSha256 !== claim.snapshotSha256 || loaded.serverBundleSha256 !== claim.serverBundleSha256 || !loaded.processStartToken) throw new Error("Held plugin operation target receipt mismatch");
  if (plugin.promotionState && plugin.promotionState.generation !== result.nativeGeneration) throw new Error("Held plugin operation CAS mismatch");
}
