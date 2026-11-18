import { MaintenanceReservation } from "../server/maintenance-reservation.js";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildSelfNodeCommand } from "../server/paseo-env.js";
import { execCommand, spawnProcess } from "./spawn.js";

const printEnvScript = `
const keys = [
  "CUSTOM",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_RUN_AS_NODE",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_NODE_ENV",
  "PASEO_SUPERVISED",
];
const values = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
console.log(JSON.stringify(values));
`;

function parsePrintedEnv(stdout: string): Record<string, string | null> {
  return JSON.parse(stdout.trim()) as Record<string, string | null>;
}

describe("execCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns stdout and stderr for a successful command", async () => {
    const result = await execCommand("echo", ["hello"]);

    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("rejects when the command times out", async () => {
    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10_000)"],
          }
        : { command: "sleep", args: ["10"] };

    await expect(execCommand(command.command, command.args, { timeout: 100 })).rejects.toThrow();
  });

  test("runs the command in the provided cwd", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-test-")));
    tempDirs.push(cwd);

    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "console.log(process.cwd())"],
          }
        : { command: "pwd", args: [] };

    const result = await execCommand(command.command, command.args, { cwd });

    expect(realpathSync(result.stdout.trim())).toBe(cwd);
    expect(result.stderr).toBe("");
  });

  test("treats env as the replacement base and finalizes external command env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "0",
        CUSTOM: "from-base",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
        PASEO_SUPERVISED: "1",
      },
      env: {
        CUSTOM: "from-env",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        PASEO_DESKTOP_MANAGED: "1",
        PASEO_NODE_ENV: "test",
      },
      envOverlay: {
        CUSTOM: "from-overlay",
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "from-overlay",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: null,
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });

  test("does not inherit process.env when env replacement is supplied", async () => {
    process.env.PASEO_TEST_SHOULD_NOT_LEAK = "leaked";
    try {
      const result = await execCommand(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ leaked: process.env.PASEO_TEST_SHOULD_NOT_LEAK ?? null }))",
        ],
        {
          env: {
            PATH: process.env.PATH,
          },
        },
      );

      expect(JSON.parse(result.stdout.trim())).toEqual({ leaked: null });
    } finally {
      delete process.env.PASEO_TEST_SHOULD_NOT_LEAK;
    }
  });

  test("spawnProcess finalizes external command env", async () => {
    const child = spawnProcess(process.execPath, ["-e", printEnvScript], {
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "0",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
      },
      envOverlay: {
        CUSTOM: "spawn-overlay",
        PASEO_SUPERVISED: "1",
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(Buffer.concat(stderrChunks).toString()).toBe("");
    expect(exitCode).toBe(0);
    expect(parsePrintedEnv(Buffer.concat(stdoutChunks).toString())).toEqual({
      CUSTOM: "spawn-overlay",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: null,
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });

  test("internal env mode preserves Paseo-owned launcher env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      envMode: "internal",
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
      },
      envOverlay: {
        CUSTOM: "internal",
        PASEO_SUPERVISED: "1",
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "internal",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: "production",
      PASEO_SUPERVISED: "1",
    });
  });

  test("does not realpath commands while finalizing external command env", async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, "native");

    await execCommand("/some/random/binary", ["--version"], {
      env: {
        PATH: process.env.PATH,
      },
      timeout: 100,
    }).catch(() => {});

    expect(realpathSpy).not.toHaveBeenCalled();
  });

  test("self node command explicitly enables Electron node mode", async () => {
    const command = buildSelfNodeCommand(["-e", printEnvScript], {
      CUSTOM: "from-helper",
    });

    const result = await execCommand(command.command, command.args, {
      env: command.env,
      envMode: "internal",
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "from-helper",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });
});

describe("maintenance process execution boundary", () => {
  test("actual child keeps admission leased after caller completes and held spawn/exec refuse before launch", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-maintenance-")));
    const reservation = (await MaintenanceReservation.create(home, async () => true));
    const child = await reservation.run(async () => {
      const launched = spawnProcess(
        process.execPath,
        [
          "-e",
          "process.send('ready'); process.on('message',()=>process.exit(0)); setTimeout(()=>process.exit(0),10000)",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await once(launched, "message");
      return launched;
    });
    try {
      await expect(reservation.begin(1, "caller-done-child-alive")).rejects.toThrow();
      const closed = once(child, "close");
      child.send!("finish");
      await closed;
      const held = await reservation.begin(1, "child-closed");
      expect(() =>
        reservation.execute(() => spawnProcess(process.execPath, ["-e", "process.exit(99)"])),
      ).toThrow("maintenance");
      await expect(
        reservation.execute(() => execCommand(process.execPath, ["-e", "process.exit(99)"])),
      ).rejects.toThrow("maintenance");
      await reservation.end(1, held.ownerToken);
    } finally {
      if (child.exitCode === null && child.connected) {
        const closed = once(child, "close");
        child.send!("finish");
        await closed;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("admitted execution continuations", () => {
  test("already-admitted helper can finish after uncertainty while every new root is closed", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "continuation-maintenance-")));
    const reservation = (await MaintenanceReservation.create(home, async () => true));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const admitted = reservation.run(async () => {
      await gate;
      return execCommand(process.execPath, ["-e", "process.stdout.write('continued')"]);
    });
    try {
      reservation.holdForUnknownWork();
      expect(() => reservation.enter()).toThrow();
      finish();
      expect((await admitted).stdout).toBe("continued");
      expect(reservation.status().state).toBe("recovery-required");
    } finally {
      finish();
      await admitted;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("expired async scope cannot revive helper authority after reservation is held", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "expired-maintenance-")));
    const reservation = (await MaintenanceReservation.create(home, async () => true));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = reservation.enter();
    const detached = reservation.executeAdmitted(release, async () => {
      await gate;
      return execCommand(process.execPath, ["-e", "process.exit(99)"]);
    });
    try {
      release();
      const held = await reservation.begin(1, "late-callback");
      finish();
      await expect(detached).rejects.toThrow("maintenance");
      await reservation.end(1, held.ownerToken);
    } finally {
      finish();
      await detached.catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
