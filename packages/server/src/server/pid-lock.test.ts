import { chmod, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  getStrictPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("strict reads and acquisition never treat opened empty or malformed records as absence", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-strict-record-"));
    const file = join(home, "paseo.pid");
    try {
      expect(await getStrictPidLockInfo(home)).toBeNull();
      for (const contents of ["", "{", "{}", JSON.stringify({ pid: "bad" })]) {
        await writeFile(file, contents);
        await expect(getStrictPidLockInfo(home)).rejects.toThrow();
        await expect(
          acquirePidLock(home, null, { ownerPid: process.pid, strict: true }),
        ).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(contents);
      }
      await writeFile(file, "");
      expect(await getPidLockInfo(home)).toBeNull();
      // The existing ordinary acquisition still reclaims an abandoned empty file.
      await acquirePidLock(home, null, { ownerPid: process.pid });
      const record = await getStrictPidLockInfo(home);
      expect(record?.pid).toBe(process.pid);
      expect(record?.listen).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test("guarded refresh and publication preserve a same-PID replacement incarnation", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-incarnation-"));
    const file = join(home, "paseo.pid");
    try {
      await acquirePidLock(home, null, { ownerPid: process.pid });
      const original = await getPidLockInfo(home);
      expect(original).not.toBeNull();
      if (!original) throw new Error("Missing actual acquired PID record");
      const expected = { ownerPid: process.pid, startedAt: original.startedAt };
      await refreshPidLock(home, expected);
      await updatePidLock(
        home,
        { listen: "/actual/daemon.sock", serverId: "original-server" },
        expected,
      );
      expect(await getPidLockInfo(home)).toMatchObject({
        pid: process.pid,
        startedAt: original.startedAt,
        listen: "/actual/daemon.sock",
      });
      const replacement = { ...original, startedAt: "2001-01-01T00:00:00.000Z", listen: null };
      await writeFile(file, JSON.stringify(replacement));
      const before = await stat(file, { bigint: true });
      const bytes = await readFile(file);
      await expect(refreshPidLock(home, expected)).rejects.toThrow("another incarnation");
      await expect(
        updatePidLock(home, { listen: "/wrong.sock", serverId: "wrong" }, expected),
      ).rejects.toThrow("another incarnation");
      expect(await readFile(file)).toEqual(bytes);
      const after = await stat(file, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      await releasePidLock(home, expected);
      expect(await readFile(file)).toEqual(bytes);
      // Existing no-stamp callers preserve their original PID-only semantics.
      await refreshPidLock(home, { ownerPid: process.pid });
      await updatePidLock(home, { listen: null, serverId: null }, { ownerPid: process.pid });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("strict release exposes malformed and unlink failures and leaves replacements alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-strict-release-"));
    const file = join(home, "paseo.pid");
    try {
      await expect(releasePidLock(home, { strict: true })).rejects.toThrow(
        "original PID and start stamp",
      );
      await acquirePidLock(home, null, { ownerPid: process.pid });
      const original = await getPidLockInfo(home);
      if (!original) throw new Error("Missing actual acquired PID record");
      const expected = {
        ownerPid: original.pid,
        startedAt: original.startedAt,
        strict: true as const,
      };
      const replacement = { ...original, startedAt: "2002-01-01T00:00:00.000Z" };
      await writeFile(file, JSON.stringify(replacement));
      await expect(releasePidLock(home, expected)).rejects.toThrow("another incarnation");
      expect(await getPidLockInfo(home)).toEqual(replacement);
      await writeFile(file, "{");
      await expect(releasePidLock(home, expected)).rejects.toBeInstanceOf(SyntaxError);
      await writeFile(file, "{}");
      await expect(releasePidLock(home, expected)).rejects.toThrow("invalid PID lock");
      await writeFile(file, JSON.stringify(original));
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        await chmod(home, 0o500);
        await expect(releasePidLock(home, expected)).rejects.toMatchObject({ code: "EACCES" });
        await chmod(home, 0o700);
        expect(await getPidLockInfo(home)).toEqual(original);
      }
      await releasePidLock(home, expected);
      expect(await getPidLockInfo(home)).toBeNull();
      await releasePidLock(home, expected);
    } finally {
      await chmod(home, 0o700);
      await rm(home, { recursive: true, force: true });
    }
  });

  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const paseoHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live desktop heartbeat lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-live-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live legacy desktop lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(paseoHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-rewrite-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(paseoHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("starts over an empty lock file left by a supervisor killed before writing it", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await expect(getPidLockInfo(paseoHome)).resolves.toBeNull();
      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a lock file whose contents cannot be read as a lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-unparseable-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(pidPath, JSON.stringify({ pid: "unknown" }));

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Cannot read daemon state");

      await expect(readFile(pidPath, "utf-8")).resolves.toBe(JSON.stringify({ pid: "unknown" }));
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
