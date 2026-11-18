import { isAbsolute, resolve } from "node:path";

export interface RecoveryOnlyRestriction {
  readonly pluginId: string;
  /** Current plugin journal CAS, separate from the native reservation generation. */
  readonly nativeGeneration: number;
  readonly baseline: {
    readonly path: string;
    readonly snapshotSha256: string;
    readonly serverBundleSha256: string;
  };
  readonly phase: "recover-required" | "verify-required";
}
/** Descriptive persisted state only; parsing cannot certify an execution outcome. */
export function parseRecoveryOnly(value: unknown): RecoveryOnlyRestriction {
  if (!value || typeof value !== "object") throw new Error("Invalid recovery restriction");
  const restriction = value as Record<string, unknown>;
  if (Object.keys(restriction).sort().join(",") !== "baseline,nativeGeneration,phase,pluginId" ||
    typeof restriction.pluginId !== "string" || !restriction.pluginId || restriction.pluginId.length > 256 ||
    !Number.isSafeInteger(restriction.nativeGeneration) || (restriction.nativeGeneration as number) < 0 ||
    !["recover-required", "verify-required"].includes(String(restriction.phase)))
    throw new Error("Invalid recovery restriction");
  return {
    pluginId: restriction.pluginId,
    nativeGeneration: restriction.nativeGeneration as number,
    phase: restriction.phase as RecoveryOnlyRestriction["phase"],
    baseline: parseRecoveryBaseline(restriction.baseline),
  };
}
function parseRecoveryBaseline(baseline: unknown): RecoveryOnlyRestriction["baseline"] {
  if (!baseline || typeof baseline !== "object") throw new Error("Invalid recovery baseline");
  const fields = baseline as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "path,serverBundleSha256,snapshotSha256" ||
    typeof fields.path !== "string" || fields.path.length > 1024 || !isAbsolute(fields.path) || resolve(fields.path) !== fields.path ||
    typeof fields.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.snapshotSha256) ||
    typeof fields.serverBundleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.serverBundleSha256))
    throw new Error("Invalid recovery baseline");
  return { path: fields.path, snapshotSha256: fields.snapshotSha256, serverBundleSha256: fields.serverBundleSha256 };
}

