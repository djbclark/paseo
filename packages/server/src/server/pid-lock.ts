import { constants, readFileSync, type BigIntStats } from "node:fs";
import { lstat, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ensurePrivateDirectory } from "./private-files.js";
import { join } from "node:path";
import { uptime } from "node:os";
import { getHostName } from "./host-name.js";
import { z } from "zod";

export const pidLockInfoSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  hostname: z.string(),
  uid: z.number(),
  listen: z.string().nullable(),
  serverId: z.string().nullable().optional(),
  desktopManaged: z.boolean().optional(),
  heartbeat: z.literal(true).optional(),
  bootId: z.string().optional(),
});

export interface PidLockInfo extends z.infer<typeof pidLockInfoSchema> {}

function parsePidLockInfo(raw: unknown): PidLockInfo | null {
  const result = pidLockInfoSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// The field is assigned explicitly rather than declared as a constructor parameter property:
// the terminal worker loads this module under --experimental-strip-types, which cannot emit
// the assignment a parameter property implies.
export class PidLockError extends Error {
  readonly existingLock?: PidLockInfo;

  constructor(message: string, existingLock?: PidLockInfo) {
    super(message);
    this.name = "PidLockError";
    this.existingLock = existingLock;
  }
}

const PID_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const PID_LOCK_READ_RETRY_ATTEMPTS = 10;
const PID_LOCK_READ_RETRY_DELAY_MS = 50;

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

// `uptime()` reports whole seconds on some platforms, so the derived boot instant carries
// about a second of error. This covers that resolution and nothing more: every extra second
// is a window in which a lock written just before a reboot still reads as current.
const BOOT_INSTANT_TOLERANCE_MS = 5_000;

function precedesThisBoot(startedAt: string): boolean {
  const stamped = Date.parse(startedAt);
  if (Number.isNaN(stamped)) return false;
  return stamped < Date.now() - uptime() * 1000 - BOOT_INSTANT_TOLERANCE_MS;
}

let cachedBootId: string | null | undefined;

// Linux names each boot. The wall-clock boot instant is not enough there: a VM paused while
// its host sleeps keeps its uptime, so after it resumes the instant lands after locks its
// running supervisor wrote.
export function currentBootId(): string | null {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
    } catch {
      cachedBootId = null;
    }
  }
  return cachedBootId;
}

/**
 * Whether a record stamped with `startedAt` (and, on Linux, `bootId`) was written during the
 * current boot. Daemon locks and terminal worker records share this rule.
 */
export function writtenDuringThisBoot(stamp: {
  startedAt: string;
  bootId?: string | null;
}): boolean {
  const thisBoot = currentBootId();
  if (stamp.bootId && thisBoot) return stamp.bootId === thisBoot;
  return !precedesThisBoot(stamp.startedAt);
}

/**
 * Whether the process that wrote this lock is still running.
 *
 * A PID alone does not identify the supervisor: the operating system hands the number to
 * something else once the supervisor is gone, and a reboot reassigns it freely. A process
 * cannot predate the boot it runs under, so a lock written during another boot is abandoned
 * however alive its PID looks.
 */
export function isPidLockOwnerRunning(lock: PidLockInfo): boolean {
  if (!writtenDuringThisBoot(lock)) return false;
  return isPidRunning(lock.pid);
}

function getPidFilePath(paseoHome: string): string {
  return join(paseoHome, "paseo.pid");
}

async function touchPidLockFile(pidPath: string): Promise<void> {
  const now = new Date();
  await utimes(pidPath, now, now);
}

async function readPidLock(pidPath: string): Promise<PidLockInfo | null> {
  let lastError: unknown;
  let empty = false;
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt++) {
    try {
      const content = await readFile(pidPath, "utf-8");
      empty = content === "";
      if (!empty) {
        const lock = parsePidLockInfo(JSON.parse(content));
        if (lock) return lock;
        lastError = new Error("Invalid lock shape");
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      empty = false;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
  }
  // A supervisor writes its lock right after creating the file, so a file still empty
  // after the retries was abandoned in between and names no owner.
  if (empty) return null;
  throw Object.assign(
    new PidLockError(`Cannot read daemon state at ${pidPath}: ${String(lastError)}`),
    { code: "DAEMON_STATE_READ_FAILED" },
  );
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

interface AcquirePidLockOptions {
  ownerPid?: number;
  strict?: true;
}

export function isSamePidLock(left: PidLockInfo, right: PidLockInfo): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function createLockHeldError(lock: PidLockInfo): PidLockError {
  return new PidLockError(
    `Another Paseo daemon is already running (PID ${lock.pid}, started ${lock.startedAt})`,
    lock,
  );
}

async function clearExistingPidLock(
  pidPath: string,
  existingLock: PidLockInfo,
  lockOwnerPid: number,
  strict = false,
): Promise<"already_owned" | "cleared"> {
  const lockOwnerRunning = isPidLockOwnerRunning(existingLock);
  if (existingLock.pid === lockOwnerPid && lockOwnerRunning) {
    await touchPidLockFile(pidPath);
    return "already_owned";
  }

  if (lockOwnerRunning) throw createLockHeldError(existingLock);
  const confirmedLock = strict ? await readStrictPidLock(pidPath) : await readPidLock(pidPath);
  if (
    !confirmedLock ||
    !isSamePidLock(existingLock, confirmedLock) ||
    isPidLockOwnerRunning(confirmedLock)
  ) {
    throw new PidLockError("PID lock changed while checking whether it was abandoned");
  }

  if (strict) await unlink(pidPath);
  else await unlink(pidPath).catch(() => {});
  return "cleared";
}

async function removeEmptyPidLock(pidPath: string): Promise<void> {
  try {
    if ((await stat(pidPath)).size === 0) await unlink(pidPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

async function writeNewPidLock(
  pidPath: string,
  lockInfo: PidLockInfo,
  strict = false,
): Promise<void> {
  if (strict) return writeStrictNewPidLock(pidPath, lockInfo);
  let fd;
  try {
    fd = await open(pidPath, "wx");
    await fd.write(JSON.stringify(lockInfo));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }

    const raceLock = await readPidLock(pidPath);
    if (raceLock) {
      throw new PidLockError(
        `Another Paseo daemon is already running (PID ${raceLock.pid})`,
        raceLock,
      );
    }
    throw new PidLockError("Failed to acquire PID lock due to race condition");
  } finally {
    await fd?.close();
  }
}

export async function acquirePidLock(
  paseoHome: string,
  listen: string | null,
  options?: AcquirePidLockOptions,
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);

  ensurePrivateDirectory(paseoHome);

  // Try to read existing lock
  const existingLock = options?.strict
    ? await readStrictPidLock(pidPath)
    : await readPidLock(pidPath);

  // Check if existing lock is stale
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  if (existingLock) {
    const result = await clearExistingPidLock(pidPath, existingLock, lockOwnerPid, options?.strict);
    if (result === "already_owned") {
      return;
    }
  } else if (!options?.strict) {
    await removeEmptyPidLock(pidPath);
  }

  // Create new lock with exclusive flag
  const bootId = currentBootId();
  const lockInfo: PidLockInfo = {
    pid: lockOwnerPid,
    startedAt: new Date().toISOString(),
    hostname: getHostName(),
    uid: process.getuid?.() ?? 0,
    listen,
    heartbeat: true,
    ...(bootId ? { bootId } : {}),
    ...(process.env.PASEO_DESKTOP_MANAGED === "1" ? { desktopManaged: true } : {}),
  };

  await writeNewPidLock(pidPath, lockInfo, options?.strict);
}

export async function refreshPidLock(
  paseoHome: string,
  options?: { ownerPid?: number; startedAt?: string },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  let fd;
  let failed: { error: unknown } | null = null;
  try {
    fd = await open(
      pidPath,
      options?.startedAt !== undefined
        ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
        : "r+",
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new PidLockError("Cannot refresh PID lock: lock file is missing");
    }
    throw error;
  }

  try {
    const lock =
      options?.startedAt !== undefined
        ? (await strictPidRecord(fd)).lock
        : await readPidLockFromHandleWithRetry(fd);
    if (!lock) {
      throw new PidLockError("Cannot refresh PID lock: invalid lock file");
    }
    if (lock.pid !== lockOwnerPid) {
      throw new PidLockError(`Cannot refresh PID lock owned by PID ${lock.pid}`, lock);
    }
    if (options?.startedAt !== undefined && lock.startedAt !== options.startedAt) {
      throw new PidLockError("Cannot refresh PID lock from another incarnation", lock);
    }
    const now = new Date();
    await fd.utimes(now, now);
  } catch (error) {
    failed = { error };
  }
  await closePidLockHandle(fd, failed, options?.startedAt !== undefined);
}

async function closePidLockHandle(
  fd: FileHandle,
  failed: { error: unknown } | null,
  guarded: boolean,
): Promise<void> {
  let closeFailed: { error: unknown } | null = null;
  try {
    await fd.close();
  } catch (error) {
    closeFailed = { error };
  }
  if (closeFailed) {
    if (failed && guarded)
      throw new AggregateError(
        [failed.error, closeFailed.error],
        "PID operation and close failed",
        { cause: failed.error },
      );
    throw closeFailed.error;
  }
  if (failed) throw failed.error;
}

function strictPidIdentity(record: BigIntStats): string {
  return [
    record.dev,
    record.ino,
    record.mode,
    record.uid,
    record.gid,
    record.nlink,
    record.size,
    record.mtimeNs,
    record.ctimeNs,
  ]
    .map(String)
    .join(":");
}

async function strictPidRecord(fd: FileHandle): Promise<{ lock: PidLockInfo; identity: string }> {
  const before = await fd.stat({ bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > 65536n)
    throw new PidLockError("Strict PID record must be a bounded nonempty regular file");
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await fd.read(buffer, total, buffer.length - total, total);
    if (!bytesRead) break;
    total += bytesRead;
    if (BigInt(total) > before.size) throw new PidLockError("Strict PID record grew during read");
  }
  const after = await fd.stat({ bigint: true });
  const identity = strictPidIdentity(before);
  if (BigInt(total) !== before.size || identity !== strictPidIdentity(after))
    throw new PidLockError("Strict PID record changed during read");
  const lock = parsePidLockInfo(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))),
  );
  if (!lock) throw new PidLockError("Cannot read invalid PID lock");
  return { lock, identity };
}

async function readStrictPidLock(pidPath: string): Promise<PidLockInfo | null> {
  let fd: FileHandle;
  try {
    fd = await open(pidPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  let result: PidLockInfo | undefined;
  let failed: { error: unknown } | null = null;
  try {
    const observed = await strictPidRecord(fd);
    const current = await lstat(pidPath, { bigint: true });
    if (!current.isFile() || strictPidIdentity(current) !== observed.identity)
      throw new PidLockError("Strict PID path changed during read");
    result = observed.lock;
  } catch (error) {
    failed = { error };
  }
  await closePidLockHandle(fd, failed, true);
  if (!result) throw new PidLockError("Strict PID read produced no record");
  return result;
}

/** No retries: only ENOENT at open is absence, never an empty/failed opened record. */
export async function getStrictPidLockInfo(paseoHome: string): Promise<PidLockInfo | null> {
  return readStrictPidLock(getPidFilePath(paseoHome));
}

async function writeStrictNewPidLock(pidPath: string, lock: PidLockInfo): Promise<void> {
  let fd: FileHandle;
  try {
    fd = await open(pidPath, "wx");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
    const raced = await readStrictPidLock(pidPath);
    const conflict = new PidLockError(
      "Failed to acquire strict PID lock due to race condition",
      raced ?? undefined,
    );
    Object.defineProperty(conflict, "cause", { value: error });
    throw conflict;
  }
  let failed: { error: unknown } | null = null;
  try {
    await fd.write(JSON.stringify(lock));
  } catch (error) {
    failed = { error };
  }
  await closePidLockHandle(fd, failed, true);
}

async function readPidLockFromHandle(fd: FileHandle): Promise<PidLockInfo | null> {
  try {
    const { size } = await fd.stat();
    if (size === 0) {
      return null;
    }
    const content = Buffer.alloc(size);
    const { bytesRead } = await fd.read(content, 0, size, 0);
    return parsePidLockInfo(JSON.parse(content.subarray(0, bytesRead).toString("utf-8")));
  } catch {
    return null;
  }
}

async function readPidLockFromHandleWithRetry(fd: FileHandle): Promise<PidLockInfo | null> {
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt += 1) {
    const lock = await readPidLockFromHandle(fd);
    if (lock) {
      return lock;
    }
    if (attempt < PID_LOCK_READ_RETRY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
    }
  }
  return null;
}

export function startPidLockHeartbeat(
  paseoHome: string,
  options?: {
    ownerPid?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  },
): () => void {
  const intervalMs = options?.intervalMs ?? PID_LOCK_HEARTBEAT_INTERVAL_MS;
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    refreshPidLock(paseoHome, { ownerPid: options?.ownerPid })
      .catch((error) => {
        if (options?.onError) {
          options.onError(error);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
      })
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

export async function updatePidLock(
  paseoHome: string,
  patch: { listen: string; serverId: string } | { listen: null; serverId: null },
  options?: { ownerPid?: number; startedAt?: string },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  const fd = await open(
    pidPath,
    options?.startedAt !== undefined
      ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
      : "r+",
  );
  let failed: { error: unknown } | null = null;
  try {
    const existingLock =
      options?.startedAt !== undefined
        ? (await strictPidRecord(fd)).lock
        : await readPidLockFromHandleWithRetry(fd);
    if (!existingLock) {
      throw new PidLockError("Cannot update PID lock: invalid lock file");
    }
    if (existingLock.pid !== lockOwnerPid) {
      throw new PidLockError(
        `Cannot update PID lock owned by PID ${existingLock.pid}`,
        existingLock,
      );
    }
    if (options?.startedAt !== undefined && existingLock.startedAt !== options.startedAt) {
      throw new PidLockError("Cannot update PID lock from another incarnation", existingLock);
    }

    const updatedLock: PidLockInfo = {
      ...existingLock,
      ...patch,
    };
    await fd.truncate(0);
    await fd.writeFile(JSON.stringify(updatedLock));
  } catch (error) {
    failed = { error };
  }
  await closePidLockHandle(fd, failed, options?.startedAt !== undefined);
}

function assertStrictPidOwner(options: {
  ownerPid?: number;
  startedAt?: string;
}): asserts options is { ownerPid: number; startedAt: string } {
  if (
    typeof options.ownerPid !== "number" ||
    !Number.isSafeInteger(options.ownerPid) ||
    options.ownerPid <= 0 ||
    typeof options.startedAt !== "string" ||
    !options.startedAt
  )
    throw new PidLockError("Strict PID release requires the original PID and start stamp");
}

async function releaseStrictPidLock(
  paseoHome: string,
  options: { ownerPid?: number; startedAt?: string },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  assertStrictPidOwner(options);
  const lock = await getStrictPidLockInfo(paseoHome);
  if (!lock) return;
  if (lock.pid !== options.ownerPid || lock.startedAt !== options.startedAt)
    throw new PidLockError("Cannot release PID lock from another incarnation", lock);
  const beforeUnlink = await getStrictPidLockInfo(paseoHome);
  if (!beforeUnlink) return;
  if (beforeUnlink.pid !== options.ownerPid || beforeUnlink.startedAt !== options.startedAt)
    throw new PidLockError("PID lock changed before strict release", beforeUnlink);
  try {
    await unlink(pidPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  const current = await getStrictPidLockInfo(paseoHome);
  if (current?.pid === options.ownerPid && current.startedAt === options.startedAt)
    throw new PidLockError("Original PID lock remains after strict release", current);
  return;
}

export async function releasePidLock(
  paseoHome: string,
  options?: { ownerPid?: number; startedAt?: string; strict?: true },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  if (options?.strict) return releaseStrictPidLock(paseoHome, options);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  try {
    // Only remove if it's our lock
    const content = await readFile(pidPath, "utf-8");
    const lock = parsePidLockInfo(JSON.parse(content));
    if (
      lock?.pid === lockOwnerPid &&
      (options?.startedAt === undefined || lock.startedAt === options.startedAt)
    ) {
      await unlink(pidPath);
    }
  } catch {
    // Ignore errors - lock may already be gone
  }
}

export async function getPidLockInfo(paseoHome: string): Promise<PidLockInfo | null> {
  const pidPath = getPidFilePath(paseoHome);
  return readPidLock(pidPath);
}

export async function isLocked(
  paseoHome: string,
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  const info = await getPidLockInfo(paseoHome);
  if (!info) {
    return { locked: false };
  }
  if (!isPidLockOwnerRunning(info)) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
