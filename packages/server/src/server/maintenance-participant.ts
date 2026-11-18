import type { HeldPluginOperationClaim, HeldPluginOperationScope } from "./maintenance-operation.js";
/** Private in-process protocol. No bearer token or candidate approval crosses this port. */
export interface MaintenanceIdentity {
  generation: number;
  transactionId: string;
}
export interface PluginMaintenancePort {
  supportsV1(): boolean;
  begin(identity: MaintenanceIdentity): Promise<"held" | "known-busy" | "unknown">;
  /** Qualified release, or confirmed rollback of every unpublished provisional barrier. */
  end(identity: MaintenanceIdentity): Promise<void>;
  restoreBeforeStart?(identity: MaintenanceIdentity): Promise<"held" | "known-busy" | "unknown">;
}

export interface NativePluginAdmission {
  enterWork(): () => void;
  holdForUnknownWork(): void;
  runHeldOperation<T>(scope: HeldPluginOperationScope, expected: HeldPluginOperationClaim, operation: () => Promise<T>): Promise<T>;
  runQualifiedInitialization<T>(operation: () => Promise<T>): Promise<T>;
}

// Unit reservations can own no additional participants. Production bootstrap always
// binds the real PluginService port, or explicitly unsupported when it is absent.
export const emptyMaintenanceParticipant: PluginMaintenancePort = {
  supportsV1: () => true,
  begin: async () => "held",
  end: async () => {},
};
export const unsupportedMaintenanceParticipant: PluginMaintenancePort = {
  supportsV1: () => false,
  begin: async () => "unknown",
  end: async () => {
    throw new Error("Plugin maintenance participant unsupported");
  },
};

export function pluginMaintenancePort(service: object): PluginMaintenancePort | undefined {
  const port = (service as { maintenance?: Partial<PluginMaintenancePort> }).maintenance;
  if (
    !port ||
    typeof port.supportsV1 !== "function" ||
    typeof port.begin !== "function" ||
    typeof port.end !== "function"
  )
    return undefined;
  return port as PluginMaintenancePort;
}

export interface QualifiedExecutionBinding {
  readonly capability: {
    assertQualifiedExecution(expectedClosure: unknown, expectedIncarnation: unknown): void;
    readonly evidenceDigest: string;
  };
  readonly expectedClosure: unknown;
  readonly expectedIncarnation: unknown;
}
export interface QualifiedDaemonOwner {
  readonly binding: QualifiedExecutionBinding;
  readonly evidenceDigest: string;
  assertFresh(): void;
  refresh(): Promise<void>;
}
export interface QualifiedDaemonAccess {
  assertQualified(): void;
  refresh(): Promise<void>;
  incarnation(): string;
}

/** Fixed producer namespace only. No config, JSON or caller callback can grant. */
export async function qualifiedDaemonExecutionAccess(owner: QualifiedDaemonOwner | undefined): Promise<QualifiedDaemonAccess> {
  const producerModule = "./execution/qualified-host.js";
  let isOwner: ((value: unknown) => boolean) | undefined;
  let isBinding: ((value: unknown, role: string) => boolean) | undefined;
  try {
    const producer: Record<string, unknown> = await import(producerModule);
    if (typeof producer.isQualifiedDaemonOwner === "function") isOwner = producer.isQualifiedDaemonOwner as typeof isOwner;
    if (typeof producer.isQualifiedExecutionBinding === "function") isBinding = producer.isQualifiedExecutionBinding as typeof isBinding;
  } catch { /* Missing genuine enclosing daemon producer remains unsupported. */ }
  const assertQualified = () => {
    if (!owner || !isOwner || !isBinding || isOwner(owner) !== true || isBinding(owner.binding, "daemon") !== true) throw new Error("Qualified enclosing daemon unavailable");
    owner.assertFresh();
    const binding = owner.binding;
    binding.capability.assertQualifiedExecution(binding.expectedClosure, binding.expectedIncarnation);
    if (typeof binding.expectedIncarnation !== "string" || !binding.expectedIncarnation) throw new Error("Invalid enclosing daemon incarnation");
  };
  return {
    assertQualified,
    async refresh() {
      assertQualified();
      await owner!.refresh();
      assertQualified();
    },
    incarnation() { assertQualified(); return owner!.binding.expectedIncarnation as string; },
  };
}

export function qualifiedMaintenanceParticipant(
  participant: PluginMaintenancePort,
  authority: QualifiedDaemonAccess,
): PluginMaintenancePort {
  return {
    supportsV1() {
      try {
        authority.assertQualified();
        return participant.supportsV1() === true;
      } catch {
        return false;
      }
    },
    async begin(identity) {
      await authority.refresh();
      const result = await participant.begin(identity);
      authority.assertQualified();
      return result;
    },
    async restoreBeforeStart(identity) {
      const result = await participant.begin(identity);
      try { authority.assertQualified(); return result; } catch { return "unknown"; }
    },
    async end(identity) {
      await authority.refresh();
      authority.assertQualified();
      await participant.end(identity);
      authority.assertQualified();
    },
  };
}
