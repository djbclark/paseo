import type {
  ManagedPluginStatus,
  PluginSource,
  PluginLoadedReceipt,
} from "@getpaseo/protocol/messages";
import type { ManagedPluginActivationPolicy } from "./activation-policy.js";

export type StatusUncertainty = Extract<
  ManagedPluginStatus,
  { consistency: "uncertain" }
>["reason"];
export function uncertainStatus(pluginId: string, reason: StatusUncertainty): ManagedPluginStatus {
  return { version: 1, pluginId, consistency: "uncertain", reason };
}
interface Observation {
  configIdentity: object;
  registration: PluginSource | undefined;
  loaded: PluginLoadedReceipt | undefined;
  epoch: number | undefined;
  busy: boolean;
}
/** No synthetic initial generation: a missing journal is explicitly uncertain. */
export async function observeManagedStatus(
  pluginId: string,
  policy: ManagedPluginActivationPolicy | undefined,
  observe: () => Observation,
): Promise<ManagedPluginStatus> {
  if (!policy?.configured) return uncertainStatus(pluginId, "policy-unconfigured");
  const before = observe();
  if (before.busy) return uncertainStatus(pluginId, "busy");
  if (!before.registration) return uncertainStatus(pluginId, "registration-missing");
  if (before.epoch === undefined) return uncertainStatus(pluginId, "runtime-unavailable");
  try {
    const first = await policy.observeStatus(pluginId);
    const last = await policy.observeStatus(pluginId);
    const after = observe();
    if (
      after.busy ||
      before.configIdentity !== after.configIdentity ||
      before.registration !== after.registration ||
      before.loaded !== after.loaded ||
      before.epoch !== after.epoch ||
      first.identity !== last.identity
    )
      return uncertainStatus(pluginId, "changed");
    const snapshot: ManagedPluginStatus = {
      version: 1,
      pluginId,
      consistency: "coherent",
      registration: before.registration,
      journal: last.state,
      loaded: before.loaded,
    };
    return structuredClone(snapshot);
  } catch (error) {
    return uncertainStatus(
      pluginId,
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "journal-missing"
        : "journal-unreadable",
    );
  }
}

/** A deadline stops waiting, never cancels an admitted lifecycle operation or releases its lease. */
export function boundedStatusRead(
  pluginId: string,
  prior: Promise<void>,
  read: () => Promise<ManagedPluginStatus>,
): { turn: Promise<ManagedPluginStatus>; result: Promise<ManagedPluginStatus> } {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turn = prior
    .then(() => (expired ? uncertainStatus(pluginId, "busy") : read()))
    .catch(() => uncertainStatus(pluginId, "runtime-unavailable"));
  const deadline = new Promise<ManagedPluginStatus>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(uncertainStatus(pluginId, "busy"));
    }, 1000);
  });
  const result = Promise.race([turn, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return { turn, result };
}
