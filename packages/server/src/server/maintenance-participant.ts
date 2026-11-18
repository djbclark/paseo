/** Private in-process protocol. No bearer token or candidate approval crosses this port. */
export interface MaintenanceIdentity {
  generation: number;
  transactionId: string;
}
export interface PluginMaintenancePort {
  supportsV1(): boolean;
  begin(identity: MaintenanceIdentity): Promise<"held" | "known-busy" | "unknown">;
  end(identity: MaintenanceIdentity): Promise<void>;
}

export interface NativePluginAdmission {
  enterWork(): () => void;
  holdForUnknownWork(): void;
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
export interface QualifiedParentExecution {
  readonly supervisor: QualifiedExecutionBinding;
  readonly daemon: QualifiedExecutionBinding;
  readonly compiler: QualifiedExecutionBinding;
}

/** Fixed producer namespace only: no JSON/env/path/test flag can construct authority. */
export async function qualifiedParentExecutionAssertion(
  chain: QualifiedParentExecution | undefined,
): Promise<() => void> {
  let isBinding: ((binding: unknown, role: string) => boolean) | undefined;
  let assertChain: ((chain: QualifiedParentExecution) => void) | undefined;
  if (chain) {
    try {
      const producerModule = "./execution/qualified-host.js";
      const producer: Record<string, unknown> = await import(producerModule);
      if (typeof producer.isQualifiedExecutionBinding === "function")
        isBinding = producer.isQualifiedExecutionBinding as typeof isBinding;
      if (typeof producer.assertQualifiedParentExecutionChain === "function")
        assertChain = producer.assertQualifiedParentExecutionChain as typeof assertChain;
    } catch {
      /* Absent producer is unsupported, never a disk/JSON fallback. */
    }
  }
  const assertQualified = () => {
    // Producer-private role/incarnation/parent-link bindings reject a real child
    // capability relabeled as a parent role, as well as fake duck callbacks.
    if (!chain || !assertChain || !isBinding)
      throw new Error("Qualified parent execution unavailable");
    for (const role of ["supervisor", "daemon", "compiler"] as const) {
      if (isBinding(chain[role], role) !== true) throw new Error("Unqualified parent role");
    }
    const chainResult: unknown = assertChain(chain);
    if (chainResult !== undefined) throw new Error("Invalid qualified parent assertion");
    for (const binding of [chain.supervisor, chain.daemon, chain.compiler]) {
      const result: unknown = binding.capability.assertQualifiedExecution(
        binding.expectedClosure,
        binding.expectedIncarnation,
      );
      if (result !== undefined) throw new Error("Invalid qualified execution assertion");
    }
  };
  return assertQualified;
}

export function qualifiedMaintenanceParticipant(
  participant: PluginMaintenancePort,
  assertQualified: () => void,
): PluginMaintenancePort {
  return {
    supportsV1() {
      try {
        assertQualified();
        return participant.supportsV1() === true;
      } catch {
        return false;
      }
    },
    async begin(identity) {
      // Restore must close the real parent barrier before startup even if complete
      // executing-role qualification is not yet available. Never END to gain receipts.
      const result = await participant.begin(identity);
      try {
        assertQualified();
        return result;
      } catch {
        return "unknown";
      }
    },
    async end(identity) {
      assertQualified();
      await participant.end(identity);
    },
  };
}
