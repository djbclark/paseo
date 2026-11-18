import type {
  HeldPluginOperationClaim,
  HeldPluginOperationScope,
} from "../maintenance-operation.js";
export interface PluginMaintenanceIdentity {
  generation: number;
  transactionId: string;
}
export interface PluginHeldRecoveryIdentity extends PluginMaintenanceIdentity {
  pluginId: string;
}
export type PluginMaintenanceState = "held" | "known-busy" | "unknown";
export interface PluginMaintenancePort {
  supportsV1(): boolean;
  begin(identity: PluginMaintenanceIdentity): Promise<PluginMaintenanceState>;
  end(identity: PluginMaintenanceIdentity): Promise<void>;
  supportsHeldRecoveryV1?(identity: PluginHeldRecoveryIdentity): boolean;
  beginHeldRecoveryV1?(identity: PluginHeldRecoveryIdentity): Promise<PluginMaintenanceState>;
}
export interface NativePluginAdmission {
  enterWork(): () => void;
  runAdmittedWork?<T>(lease: () => void, operation: () => T): T;
  holdForUnknownWork(): void;
  runQualifiedInitialization<T>(operation: () => Promise<T>): Promise<T>;
  runHeldOperation?<T>(
    scope: HeldPluginOperationScope,
    claim: HeldPluginOperationClaim,
    operation: () => Promise<T>,
  ): Promise<T>;
}
export function samePluginMaintenanceIdentity(
  left: PluginMaintenanceIdentity,
  right: PluginMaintenanceIdentity,
): boolean {
  return left.generation === right.generation && left.transactionId === right.transactionId;
}
