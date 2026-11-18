export interface PluginMaintenanceIdentity {
  generation: number;
  transactionId: string;
}
export type PluginMaintenanceState = "held" | "known-busy" | "unknown";
export interface PluginMaintenancePort {
  supportsV1(): boolean;
  begin(identity: PluginMaintenanceIdentity): Promise<PluginMaintenanceState>;
  end(identity: PluginMaintenanceIdentity): Promise<void>;
}
export interface NativePluginAdmission {
  enterWork(): () => void;
  holdForUnknownWork(): void;
  runQualifiedInitialization<T>(operation: () => Promise<T>): Promise<T>;
}
export function samePluginMaintenanceIdentity(
  left: PluginMaintenanceIdentity,
  right: PluginMaintenanceIdentity,
): boolean {
  return left.generation === right.generation && left.transactionId === right.transactionId;
}
