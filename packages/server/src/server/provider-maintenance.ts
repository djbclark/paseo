import type { AgentClient, AgentSession } from "./agent/agent-sdk-types.js";
import type { MaintenanceReservation } from "./maintenance-reservation.js";

// Exhaustive classification: extending AgentClient requires deciding its execution authority.
const policy = {
  provider: "value", capabilities: "value",
  createSession: "session", resumeSession: "session",
  getCatalogCacheKey: "execution", fetchCatalog: "execution", resolveDefaultModeId: "execution",
  listCommands: "execution", listControls: "execution", listImportableSessions: "execution",
  importSession: "execution", isAvailable: "execution", getDiagnostic: "execution",
  archiveNativeSession: "execution", unarchiveNativeSession: "execution",
  resolveConfiguredModel: "pure", resolveCreateConfig: "pure", isCreateConfigUnattended: "pure", effectiveOptions: "pure",
  shutdown: "cleanup",
} as const satisfies Record<keyof AgentClient, "value" | "pure" | "execution" | "session" | "cleanup">;
const clients = new WeakMap<AgentClient, MaintenanceReservation>();
const sessions = new WeakMap<AgentSession, MaintenanceReservation>();

/** Install before exposing a configured client, including registry model/discovery clients. */
export function guardProviderClient(client: AgentClient, reservation?: MaintenanceReservation): AgentClient {
  if (!reservation) return client;
  const previous = clients.get(client);
  if (previous) {
    if (previous !== reservation) throw new Error("Provider client already has an admission owner");
    return client;
  }
  clients.set(client, reservation);
  const live = new Map<AgentSession, () => void>();
  for (const key of Object.keys(policy) as (keyof AgentClient)[]) {
    const kind = policy[key];
    if (kind === "pure" || kind === "value") continue;
    const operation = client[key];
    if (typeof operation !== "function") continue;
    const call = operation as (...args: unknown[]) => Promise<unknown>;
    const wrapped = kind === "cleanup" ? async (...args: unknown[]) => {
      // Cleanup remains possible while held; successful shutdown confirms client resources ended.
      try {
        const result = await reservation.runCleanup(() => call.apply(client, args));
        for (const [session, release] of live) { release(); sessions.delete(session); }
        live.clear();
        return result;
      } catch (error) { reservation.holdForUnknownWork(); throw error; }
    } : async (...args: unknown[]) => {
      const release = reservation.enter();
      let retained = false;
      try {
        const result = await reservation.executeAdmitted(release, () => call.apply(client, args));
        if (kind === "session") {
          const session = result as AgentSession;
          const owner = sessions.get(session);
          if (owner && owner !== reservation) throw new Error("Provider session has another admission owner");
          if (!owner) {
            sessions.set(session, reservation);
            live.set(session, release);
            retained = true;
            const close = session.close.bind(session);
            session.close = async () => {
              try {
                await reservation.runCleanup(close);
                release(); live.delete(session); sessions.delete(session);
              } catch (error) { reservation.holdForUnknownWork(); throw error; }
            };
          }
        }
        return result;
      } finally { if (!retained) release(); }
    };
    Object.defineProperty(client, key, { value: wrapped, writable: true, configurable: true });
  }
  return client;
}
