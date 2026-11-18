import { assertHeldPluginOperation } from "../maintenance-reservation.js";
import type {
  HeldPluginOperationClaim,
  HeldPluginOperationScope,
} from "../maintenance-operation.js";

export interface PluginHeldOperation {
  readonly claim: HeldPluginOperationClaim;
  readonly scope: HeldPluginOperationScope;
}
export function assertPluginHeldOperation(
  held: PluginHeldOperation,
  pluginId: string,
  sourcePath: string,
): void {
  assertHeldPluginOperation(held.scope, held.claim);
  if (held.claim.pluginId !== pluginId || held.claim.path !== sourcePath)
    throw new Error("Held plugin target mismatch");
}

// Fixed native read boundary; minting stays private inside the actual trusted driver.
export { readKnownFailedHeld } from "./index.js";
