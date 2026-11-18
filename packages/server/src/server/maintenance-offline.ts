import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, parse } from "node:path";

/** Read-only authority check. Neither HOME nor a candidate may select this path. */
export function verifyOfflineMaintenance(generation: number, transactionId: string) {
  const account = userInfo();
  const path = join(account.homedir, ".paseo", "maintenance-reservation.json");
  function checkAncestors() {
    let ancestor = dirname(path);
    while (true) {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== account.uid) || (stat.mode & 0o022))
        throw new Error("Unprotected maintenance authority path");
      if (ancestor === parse(ancestor).root) break;
      ancestor = dirname(ancestor);
    }
  }
  checkAncestors();
  const beforePath = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== account.uid || (before.mode & 0o077) || before.nlink !== 1 || before.size > 4096 ||
      before.dev !== beforePath.dev || before.ino !== beforePath.ino) throw new Error("Unprotected maintenance record");
    const record = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    checkAncestors();
    if (before.dev !== afterPath.dev || before.ino !== afterPath.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.mode !== before.mode ||
      Object.keys(record).sort().join(",") !== "generation,schemaVersion,tokenDigest,transactionId" ||
      record.schemaVersion !== 1 || !Number.isSafeInteger(record.generation) || record.generation !== generation || generation <= 0 ||
      typeof record.transactionId !== "string" || !transactionId || record.transactionId !== transactionId ||
      typeof record.tokenDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.tokenDigest))
      throw new Error("Maintenance authority changed or mismatched");
    return { schemaVersion: 1 as const, state: "recovery-required" as const, generation, transactionId, recoveryRequired: true };
  } finally { closeSync(fd); }
}
