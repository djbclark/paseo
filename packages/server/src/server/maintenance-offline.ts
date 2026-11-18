import { parseRecoveryOnly, type RecoveryOnlyRestriction } from "./maintenance-recovery.js";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, parse } from "node:path";

export const MISSING_MAINTENANCE_AUTHORITY = Symbol("missing maintenance authority");

export interface MaintenanceRecord {
  schemaVersion: 1;
  generation: number;
  transactionId: string | null;
  tokenDigest: string | null;
  uncertain?: boolean;
  recoveryOnly?: RecoveryOnlyRestriction;
}

function validateProtectedRecord(before: Stats, beforePath: Stats, uid: number): void {
  if (
    !before.isFile() ||
    before.uid !== uid ||
    before.mode & 0o077 ||
    before.nlink !== 1 ||
    before.size > 4096 ||
    before.dev !== beforePath.dev ||
    before.ino !== beforePath.ino
  )
    throw new Error("Unprotected maintenance record");
}

function assertStableRecord(before: Stats, after: Stats, afterPath: Stats): void {
  if (
    before.dev !== afterPath.dev ||
    before.ino !== afterPath.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.mode !== before.mode ||
    before.uid !== after.uid ||
    before.nlink !== after.nlink ||
    afterPath.mode !== after.mode ||
    afterPath.uid !== after.uid ||
    afterPath.nlink !== after.nlink
  )
    throw new Error("Maintenance authority changed");
}

/** The caller chooses only a trusted daemon configuration home, never a candidate path. */
export async function readProtectedMaintenanceJson(
  home: string,
  name: "maintenance-enrollment.json" | "maintenance-reservation.json",
): Promise<unknown> {
  const account = userInfo();
  const path = join(home, name);
  async function checkAncestors() {
    const snapshots: { path: string; dev: number; ino: number; mode: number; uid: number }[] = [];
    let ancestor = dirname(path);
    while (true) {
      const stat = await lstat(ancestor);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== account.uid) ||
        (stat.mode & 0o022 && !(ancestor !== dirname(path) && stat.uid === 0 && stat.mode & 0o1000))
      )
        throw new Error("Unprotected maintenance authority path");
      snapshots.push({
        path: ancestor,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
      });
      if (ancestor === parse(ancestor).root) break;
      ancestor = dirname(ancestor);
    }
    return snapshots;
  }
  const ancestorsBefore = await checkAncestors();
  let beforePath;
  try {
    beforePath = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (JSON.stringify(ancestorsBefore) !== JSON.stringify(await checkAncestors()))
        throw new Error("Maintenance authority changed", { cause: error });
      return MISSING_MAINTENANCE_AUTHORITY;
    }
    throw error;
  }
  if (!beforePath.isFile() || beforePath.isSymbolicLink())
    throw new Error("Nonregular maintenance authority");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    validateProtectedRecord(before, beforePath, account.uid);
    const bytes = Buffer.alloc(4097);
    const { bytesRead: length } = await fd.read(bytes, 0, bytes.length, null);
    if (length !== before.size || length > 4096)
      throw new Error("Unstable maintenance authority size");
    const record: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    const after = await fd.stat();
    const afterPath = await lstat(path);
    const ancestorsAfter = await checkAncestors();
    if (JSON.stringify(ancestorsBefore) !== JSON.stringify(ancestorsAfter))
      throw new Error("Maintenance authority ancestors changed");
    assertStableRecord(before, after, afterPath);
    return record;
  } finally {
    await fd.close();
  }
}

export function parseMaintenanceRecord(value: unknown): MaintenanceRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid maintenance record");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "schemaVersion",
          "generation",
          "transactionId",
          "tokenDigest",
          "uncertain",
          "recoveryOnly",
        ].includes(key),
    ) ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 0 ||
    !(
      record.tokenDigest === null ||
      (typeof record.tokenDigest === "string" && /^[a-f0-9]{64}$/.test(record.tokenDigest))
    ) ||
    !(record.uncertain === undefined || typeof record.uncertain === "boolean") ||
    (record.generation === 0
      ? record.transactionId !== null || record.tokenDigest !== null
      : typeof record.transactionId !== "string" ||
        !record.transactionId ||
        record.transactionId.length > 256)
  )
    throw new Error("Invalid maintenance record");
  parseRecordRestriction(record);
  return record as unknown as MaintenanceRecord;
}
function parseRecordRestriction(record: Record<string, unknown>): void {
  if (record.recoveryOnly !== undefined) {
    if (!record.tokenDigest || record.generation === 0)
      throw new Error("Recovery restriction requires held authority");
    record.recoveryOnly = parseRecoveryOnly(record.recoveryOnly);
  }
}
export function validateMaintenanceEnrollment(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "component,schemaVersion" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (value as { component?: unknown }).component !== "paseo-maintenance"
  )
    throw new Error("Invalid maintenance enrollment");
}

/** Fixed real-account authority; HOME, CLI flags and artifacts cannot select this home. */
export async function verifyOfflineMaintenance(generation: number, transactionId: string) {
  const home = join(userInfo().homedir, ".paseo");
  validateMaintenanceEnrollment(
    await readProtectedMaintenanceJson(home, "maintenance-enrollment.json"),
  );
  const record = parseMaintenanceRecord(
    await readProtectedMaintenanceJson(home, "maintenance-reservation.json"),
  );
  validateMaintenanceEnrollment(
    await readProtectedMaintenanceJson(home, "maintenance-enrollment.json"),
  );
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    record.generation !== generation ||
    !transactionId ||
    record.transactionId !== transactionId ||
    !record.tokenDigest ||
    record.uncertain
  )
    throw new Error("Maintenance ownership mismatch or uncertain authority");
  return {
    schemaVersion: 1 as const,
    state: "recovery-required" as const,
    generation,
    transactionId,
    recoveryRequired: true,
    ...(record.recoveryOnly ? { recoveryOnly: record.recoveryOnly } : {}),
  };
}
