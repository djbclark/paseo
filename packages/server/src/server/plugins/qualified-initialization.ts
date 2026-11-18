import { isQualifiedDaemonOwner } from "../execution/qualified-host.js";
import type { QualifiedDaemonOwner } from "../execution/daemon-types.js";
import type { NativePluginAdmission } from "./maintenance.js";

declare const initializationBrand: unique symbol;
export interface QualifiedPluginInitialization {
  readonly [initializationBrand]: true;
}
interface InitializationEntry {
  owner: QualifiedDaemonOwner;
  native: NativePluginAdmission;
  pluginId: string;
  sourcePath: string;
  active: boolean;
}
const initializations = new WeakMap<QualifiedPluginInitialization, InitializationEntry>();
export function assertQualifiedPluginInitialization(
  scope: QualifiedPluginInitialization,
  owner: QualifiedDaemonOwner,
  native: NativePluginAdmission,
  pluginId: string,
  sourcePath: string,
): void {
  const entry = initializations.get(scope);
  if (
    !entry?.active ||
    entry.owner !== owner ||
    entry.native !== native ||
    entry.pluginId !== pluginId ||
    entry.sourcePath !== sourcePath ||
    !isQualifiedDaemonOwner(owner)
  )
    throw new Error("Qualified plugin initialization scope mismatch");
  owner.assertFresh();
}

/** Trusted daemon startup only; the native lease owns actual initialization settlement. */
export async function runQualifiedPluginInitialization<T>(
  owner: QualifiedDaemonOwner,
  native: NativePluginAdmission,
  pluginId: string,
  sourcePath: string,
  operation: (scope: QualifiedPluginInitialization) => Promise<T>,
): Promise<T> {
  if (!isQualifiedDaemonOwner(owner)) throw new Error("Qualified initialization owner unavailable");
  await owner.refresh();
  return native.runQualifiedInitialization(async () => {
    const scope = Object.freeze({}) as QualifiedPluginInitialization;
    const entry = { owner, native, pluginId, sourcePath, active: true };
    initializations.set(scope, entry);
    try {
      return await operation(scope);
    } finally {
      entry.active = false;
    }
  });
}
