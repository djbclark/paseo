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
