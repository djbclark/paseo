import type { ActivationTicket } from "./activation-policy.js";
import {
  PluginDirectoryInitializationSchema,
  type PluginDirectoryInitialization,
  type PluginMaintenanceIdentity,
} from "./plugin-process-protocol.js";

/** Snapshot the actual ticket at dispatch; neither this DATA nor its schema grants execution. */
export function directoryInitializationFromTicket(
  ticket: ActivationTicket | undefined,
  hold?: PluginMaintenanceIdentity,
): PluginDirectoryInitialization | undefined {
  const profile = ticket?.authorization.directoryHelperProfile;
  if (!ticket || !profile) return undefined;
  if (ticket.authorization.passiveProfile)
    throw new Error("Managed execution profiles are mutually exclusive");
  return PluginDirectoryInitializationSchema.parse({
    contract: "ade-directory-helpers-v1",
    activationGeneration: ticket.generation,
    operation: ticket.authorization.operation,
    profile,
    snapshotRoot: ticket.authorization.snapshotRoot,
    snapshotSha256: ticket.authorization.snapshotSha256,
    ...(hold ? { hold } : {}),
  });
}
