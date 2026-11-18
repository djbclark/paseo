import { parseRecoveryOnly, type RecoveryOnlyRestriction } from "./maintenance-recovery.js";
export { parseRecoveryOnly } from "./maintenance-recovery.js";
export type { RecoveryOnlyRestriction } from "./maintenance-recovery.js";
import * as heldPluginOperation from "./plugins/held-operation.js";
import type { PluginLoadedReceipt } from "@getpaseo/protocol/messages";
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

export interface HeldPluginOperationResult {
  plugin: PluginListItem;
  nativeGeneration: number;
}
export interface KnownFailedHeldObservation {
  readonly outcome: "known_failed_held";
  readonly reason: "compiler_error" | "initialization_rejected";
  readonly pluginId: string;
  readonly nativeGeneration: number;
  readonly current: {
    readonly registration: { readonly path: string; readonly enabled: boolean } | null;
    readonly loaded: PluginLoadedReceipt | null;
  };
  readonly baseline: RecoveryOnlyRestriction["baseline"];
}

export type HeldPluginOperationDriver = (
  claim: HeldPluginOperationClaim,
  scope: HeldPluginOperationScope,
) => Promise<HeldPluginOperationResult | KnownFailedHeldObservation>;
export function heldPluginOperationDriver(service: object): HeldPluginOperationDriver | undefined {
  const method = (service as { heldPluginOperation?: HeldPluginOperationDriver })
    .heldPluginOperation;
  return typeof method === "function" ? method.bind(service) : undefined;
}

/** The trusted service still must return the exact requested loaded target. */
export function assertHeldPluginOperationResult(
  claim: HeldPluginOperationClaim,
  result: HeldPluginOperationResult,
): void {
  const plugin = result.plugin;
  const loaded = plugin.loaded;
  if (
    !Number.isSafeInteger(result.nativeGeneration) ||
    result.nativeGeneration < claim.expectedGeneration ||
    plugin.id !== claim.pluginId ||
    plugin.path !== claim.path ||
    !plugin.enabled ||
    plugin.status !== "running"
  )
    throw new Error("Invalid held plugin operation result");
  if (
    !loaded ||
    loaded.pluginId !== claim.pluginId ||
    loaded.sourcePath !== claim.path ||
    loaded.snapshotSha256 !== claim.snapshotSha256 ||
    loaded.serverBundleSha256 !== claim.serverBundleSha256 ||
    !loaded.processStartToken
  )
    throw new Error("Held plugin operation target receipt mismatch");
  if (
    plugin.promotionState &&
    (plugin.promotionState.generation !== result.nativeGeneration ||
      plugin.promotionState.phase !== "ready")
  )
    throw new Error("Held plugin operation CAS mismatch");
}


/** Fixed bundled module only; absent committed private validator means unsupported. */
export function supportsKnownFailedHeld(): boolean {
  return "readKnownFailedHeld" in heldPluginOperation && typeof heldPluginOperation.readKnownFailedHeld === "function";
}
export function readPrivateKnownFailedHeld(
  result: unknown,
  scope: HeldPluginOperationScope,
  claim: HeldPluginOperationClaim,
): KnownFailedHeldObservation | undefined {
  if (!("readKnownFailedHeld" in heldPluginOperation) || typeof heldPluginOperation.readKnownFailedHeld !== "function") {
    if (result && typeof result === "object" && "outcome" in result)
      throw new Error("Known held outcome unsupported");
    return undefined;
  }
  // The fixed plugin module owns the private provenance table. No caller callback is accepted.
  const observation = heldPluginOperation.readKnownFailedHeld(result, scope, claim);
  if (observation === undefined) return undefined;
  if (!observation || observation.outcome !== "known_failed_held" ||
    !["compiler_error", "initialization_rejected"].includes(observation.reason) ||
    observation.pluginId !== claim.pluginId || claim.operation === "verify" ||
    !Number.isSafeInteger(observation.nativeGeneration) || observation.nativeGeneration < claim.expectedGeneration)
    throw new Error("Invalid known held outcome");
  parseRecoveryOnly({ pluginId: observation.pluginId, nativeGeneration: observation.nativeGeneration,
    baseline: observation.baseline, phase: "recover-required" });
  return observation;
}
