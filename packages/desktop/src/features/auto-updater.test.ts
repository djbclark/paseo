import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { describe, expect, it, vi } from "vitest";

const { autoUpdaterMock } = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  return {
    autoUpdaterMock: {
      handlers,
      logger: {
        debug: vi.fn(),
        error: vi.fn((message: unknown) => console.error(message)),
        info: vi.fn(),
        warn: vi.fn(),
      },
      autoDownload: true,
      isUserWithinRollout: async (_info: unknown) => true,
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.set(event, handler);
      }),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
    isPackaged: true,
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import {
  ElectronAppUpdateRuntime,
  bucketFromStagingUserId,
  checkForAppUpdate,
  createAppUpdateLifecycleLogger,
  resolveStagingUserId,
  rolloutManifestSchema,
  shouldAdmitToRollout,
  shouldInstallAppUpdateOnQuit,
} from "./auto-updater";

describe("checkForAppUpdate", () => {
  it("treats an unpublished channel manifest as an unavailable update", async () => {
    const error = Object.assign(new Error("Cannot find latest-mac.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps genuine updater failures visible", async () => {
    const error = new Error("network down");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result.errorMessage).toBe("network down");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("logs the update handoff with current and selected target versions", () => {
    const info = vi.fn();
    const lifecycleLog = createAppUpdateLifecycleLogger({ info });

    lifecycleLog.checkStarted({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    lifecycleLog.checkCompleted({
      currentVersion: "1.2.3",
      targetVersion: "1.2.5",
      releaseChannel: "stable",
      intent: "manual",
      hasUpdate: true,
      readyToInstall: true,
      errorMessage: null,
    });
    lifecycleLog.updateDownloaded("1.2.4");
    lifecycleLog.downloadRequested("1.2.5");
    lifecycleLog.quitAndInstallRequested({
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });

    expect(info).toHaveBeenCalledWith("[auto-updater] check started", {
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] update downloaded", {
      targetVersion: "1.2.4",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] download requested", {
      targetVersion: "1.2.5",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] quitAndInstall requested", {
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });
  });
});

describe("shouldInstallAppUpdateOnQuit", () => {
  it("keeps Linux AppImage updates on the manual install path", () => {
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: true })).toBe(false);
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "darwin", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "win32", isAppImage: false })).toBe(true);
  });
});

describe("shouldAdmitToRollout", () => {
  it("admits beta, missing rollout hours, zero-hour rollout, and missing release date", () => {
    expect(
      shouldAdmitToRollout({
        channel: "beta",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: undefined,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 0,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: undefined,
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("blocks future releases and respects the linear threshold mid-rollout", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T02:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.49,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.51,
      }),
    ).toBe(false);
  });

  it("blocks the bucket-zero client at exact release time, admits as soon as time advances", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.001Z"),
        bucket: 0,
      }),
    ).toBe(true);
  });

  it("admits the highest-bucket client at and past the rollout end", () => {
    const maxBucket = (0x100000000 - 1) / 0x100000000;
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-29T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2027-04-28T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
  });

  it("admits when releaseDate is unparseable", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "not a date",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("treats garbage manifest rollout fields as missing and admits", () => {
    const parsed = rolloutManifestSchema.parse({
      rolloutHours: "not a number",
      releaseDate: 12345,
    });

    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("maps the maximum 32-bit slot to a bucket strictly less than 1", () => {
    const allOnes = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const allZeros = "00000000-0000-0000-0000-000000000000";
    expect(bucketFromStagingUserId(allOnes)).toBeLessThan(1);
    expect(bucketFromStagingUserId(allOnes)).toBeGreaterThan(0.999);
    expect(bucketFromStagingUserId(allZeros)).toBe(0);
  });

  it("creates and then reuses the on-disk staging user id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-updater-id-"));
    const filePath = path.join(tempDir, ".updaterId");

    try {
      const first = await resolveStagingUserId(filePath);
      const stored = (await readFile(filePath, "utf8")).trim();
      const second = await resolveStagingUserId(filePath);

      expect(UUID.check(stored)).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("managed Electron runtime boundaries", () => {
  const configuration = {
    releaseChannel: "stable" as const,
    shouldAdmitUpdate: async () => true,
    onUpdateAvailable: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onError: vi.fn(),
  };
  it("disables automatic acquisition and refuses a missing policy before feed access", async () => {
    const { ManagedDesktopAuthority } = await import("./managed-desktop-policy");
    const authority = new ManagedDesktopAuthority(() => {
      throw new Error("missing policy");
    });
    const runtime = new ElectronAppUpdateRuntime(authority);
    runtime.configure(configuration);
    expect(autoUpdaterMock.autoDownload).toBe(false);
    const prior = autoUpdaterMock.checkForUpdates.mock.calls.length;
    await expect(runtime.checkForUpdates()).rejects.toThrow("policy unavailable");
    expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBe(prior);
  });
  it("fails closed on rollout callback errors only for managed builds", async () => {
    const { ManagedDesktopAuthority } = await import("./managed-desktop-policy");
    const bad = {
      ...configuration,
      shouldAdmitUpdate: async () => {
        throw new Error("bad metadata");
      },
    };
    new ElectronAppUpdateRuntime(new ManagedDesktopAuthority()).configure(bad);
    expect(await autoUpdaterMock.isUserWithinRollout({})).toBe(false);
    new ElectronAppUpdateRuntime(null).configure(bad);
    expect(await autoUpdaterMock.isUserWithinRollout({})).toBe(true);
    expect(autoUpdaterMock.autoDownload).toBe(true);
  });
  it("refuses staged install without verified archive even when called directly", async () => {
    const { ManagedDesktopAuthority } = await import("./managed-desktop-policy");
    const runtime = new ElectronAppUpdateRuntime(new ManagedDesktopAuthority());
    expect(() =>
      runtime.quitAndInstall({ targetVersion: "1.2.4", isSilent: true, isForceRunAfter: false }),
    ).toThrow("staged artifact unavailable");
  });
});

describe("managed acquisition integration", () => {
  async function setup() {
    const { ManagedDesktopAuthority } = await import("./managed-desktop-policy");
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-runtime-"));
    const archive = path.join(directory, "app.zip");
    await writeFile(archive, "qualified archive");
    const sha512 = Buffer.alloc(64, 1).toString("base64");
    const current = {
      schemaVersion: 1 as const,
      component: "paseo-desktop" as const,
      generation: 1,
      stateCompatibility: "binary-only" as const,
      operations: {
        download: {
          allowed: true as const,
          transactionId: "tx",
          receiptSha256: "a".repeat(64),
          version: "1.2.4",
          archiveSha256: createHash("sha256").update("qualified archive").digest("hex"),
          archiveSha512: sha512,
          packageUrl: "https://example.com/qualified/app.zip",
        },
      },
    };
    const authority = new ManagedDesktopAuthority(() => current);
    const runtime = new ElectronAppUpdateRuntime(authority);
    const configuration = {
      releaseChannel: "stable" as const,
      shouldAdmitUpdate: async () => true,
      onUpdateAvailable: vi.fn(),
      onUpdateDownloaded: vi.fn(),
      onError: vi.fn(),
    };
    runtime.configure(configuration);
    const info = { version: "1.2.4", files: [{ url: "app.zip", sha512 }] };
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    await runtime.checkForUpdates();
    return { directory, archive, current, authority, runtime, configuration, info };
  }
  it("uses protected feed and rejects policy changes during download wait", async () => {
    const h = await setup();
    try {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: "generic",
        url: "https://example.com/qualified/",
      });
      let finish!: (files: string[]) => void;
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = h.runtime.downloadUpdate("1.2.4");
      h.current.generation = 2;
      finish([h.archive]);
      await expect(pending).rejects.toThrow("changed");
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
  it("rechecks cached bytes and holds activation without the native bridge", async () => {
    const h = await setup();
    try {
      autoUpdaterMock.downloadUpdate.mockResolvedValueOnce([h.archive]);
      await h.runtime.downloadUpdate("1.2.4");
      const bundleCheck = vi
        .spyOn(h.authority, "verifyInstalledBundle")
        .mockImplementation(() => undefined);
      expect(() => h.runtime.prepareInstall("1.2.4")).toThrow("reservation adapter unavailable");
      expect(bundleCheck).toHaveBeenCalled();
      await writeFile(h.archive, "tampered staged cache");
      expect(() => h.runtime.prepareInstall("1.2.4")).toThrow("archive mismatch");
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
  it("does not publish a ready event for a staged-file mismatch", async () => {
    const h = await setup();
    try {
      await writeFile(h.archive, "not qualified");
      autoUpdaterMock.handlers.get("update-downloaded")?.({ ...h.info, downloadedFile: h.archive });
      expect(h.configuration.onUpdateDownloaded).not.toHaveBeenCalled();
      expect(h.configuration.onError).toHaveBeenCalled();
    } finally {
      await rm(h.directory, { recursive: true, force: true });
    }
  });
});

describe("Mac manual-download completion", () => {
  it("accepts an empty download result only after a verified downloaded-file event", async () => {
    const { ManagedDesktopAuthority } = await import("./managed-desktop-policy");
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-mac-"));
    try {
      const archive = path.join(directory, "app.zip");
      await writeFile(archive, "qualified");
      const sha512 = Buffer.alloc(64, 1).toString("base64");
      const authority = new ManagedDesktopAuthority(() => ({
        schemaVersion: 1,
        component: "paseo-desktop",
        generation: 1,
        stateCompatibility: "binary-only",
        operations: {
          download: {
            allowed: true,
            transactionId: "tx",
            receiptSha256: "a".repeat(64),
            version: "1.2.4",
            archiveSha256: createHash("sha256").update("qualified").digest("hex"),
            archiveSha512: sha512,
            packageUrl: "https://example.com/app.zip",
          },
        },
      }));
      const runtime = new ElectronAppUpdateRuntime(authority);
      runtime.configure({
        releaseChannel: "stable",
        shouldAdmitUpdate: async () => true,
        onUpdateAvailable: vi.fn(),
        onUpdateDownloaded: vi.fn(),
        onError: vi.fn(),
      });
      const info = {
        version: "1.2.4",
        files: [{ url: "app.zip", sha512 }],
        downloadedFile: archive,
      };
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: info,
      });
      await runtime.checkForUpdates();
      autoUpdaterMock.downloadUpdate.mockResolvedValueOnce([]);
      await expect(runtime.downloadUpdate("1.2.4")).rejects.toThrow("archive unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        autoUpdaterMock.handlers.get("update-downloaded")?.(info);
        return [];
      });
      await expect(runtime.downloadUpdate("1.2.4")).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
