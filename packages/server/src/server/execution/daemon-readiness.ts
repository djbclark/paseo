import {
  acquirePidLock,
  getStrictPidLockInfo,
  isPidLockOwnerRunning,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "../pid-lock.js";

const activeHomes = new Set<string>();

function failures(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Daemon metadata operations failed", { cause: errors[0] });
}

/** Ordinary discovery metadata, never a qualified owner or a maintenance receipt. */
export async function acquireQualifiedDaemonReadiness(home: string) {
  if (activeHomes.has(home))
    throw new PidLockError("Daemon metadata already owned in this process");
  activeHomes.add(home);
  try {
    const existing = await getStrictPidLockInfo(home);
    if (existing && isPidLockOwnerRunning(existing))
      throw new PidLockError("Another live daemon metadata incarnation exists", existing);
    await acquirePidLock(home, null, { ownerPid: process.pid, strict: true });
    const original = await getStrictPidLockInfo(home);
    if (!original || original.pid !== process.pid || original.listen !== null)
      throw new PidLockError("Daemon metadata acquisition identity changed");
    const expected = Object.freeze({ ownerPid: original.pid, startedAt: original.startedAt });
    const originalBootId = original.bootId;
    const errors: unknown[] = [];
    let sealed = false;
    let tail: Promise<void> = Promise.resolve();
    let clearing: Promise<void> | null = null;
    let heartbeat: Promise<void> | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let notifyFailure!: (error: unknown) => void;
    const failed = new Promise<unknown>((resolve) => {
      notifyFailure = resolve;
    });

    async function assertOriginal(): Promise<void> {
      const current = await getStrictPidLockInfo(home);
      if (
        !current ||
        current.pid !== expected.ownerPid ||
        current.startedAt !== expected.startedAt ||
        current.bootId !== originalBootId
      )
        throw new PidLockError("Daemon metadata ownership changed", current ?? undefined);
    }
    function enqueue(operation: () => Promise<void>): Promise<void> {
      const task = tail.then(operation);
      tail = task.then(
        () => undefined,
        (error) => {
          errors.push(error);
          notifyFailure(error);
          return undefined;
        },
      );
      return task;
    }
    function clearAndDrain(): Promise<void> {
      if (clearing) return clearing;
      sealed = true;
      if (timer) clearInterval(timer);
      // Already admitted heartbeat/publication writes precede this null publication.
      const clear = enqueue(async () => {
        await assertOriginal();
        await updatePidLock(home, { listen: null, serverId: null }, expected);
        await assertOriginal();
      });
      clearing = (async () => {
        await clear.catch(() => undefined);
        await tail;
        failures(errors);
      })();
      return clearing;
    }
    function pulse(): void {
      if (sealed || heartbeat) return;
      heartbeat = enqueue(async () => {
        await assertOriginal();
        await refreshPidLock(home, expected);
        await assertOriginal();
      });
      void heartbeat.then(
        () => {
          heartbeat = null;
          return undefined;
        },
        () => {
          heartbeat = null;
          // Retain the error and retire actual writes; never keep stale ready metadata.
          void clearAndDrain().catch(() => undefined);
          return undefined;
        },
      );
    }
    timer = setInterval(pulse, 30000);
    timer.unref();
    return Object.freeze({
      failed,
      assertHealthy(): void {
        failures(errors);
      },
      async publish(listen: string, serverId: string): Promise<void> {
        if (sealed) throw new PidLockError("Daemon metadata admission is closed");
        failures(errors);
        if (!listen || !serverId || listen.includes("\0") || serverId.includes("\0"))
          throw new PidLockError("Actual daemon listen target and server ID required");
        await enqueue(async () => {
          failures(errors);
          await assertOriginal();
          await updatePidLock(home, { listen, serverId }, expected);
          await assertOriginal();
        });
      },
      clearAndDrain,
      async releaseAfterStop(): Promise<void> {
        await clearAndDrain();
        await releasePidLock(home, { ...expected, strict: true });
        activeHomes.delete(home);
      },
    });
  } catch (error) {
    activeHomes.delete(home);
    throw error;
  }
}
