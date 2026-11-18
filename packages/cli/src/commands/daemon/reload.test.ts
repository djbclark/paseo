import { connectToDaemon } from "../../utils/client.js";
vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonMaintenanceCommand, readMaintenanceOwnerToken, maintenanceBeginRefusal } from "./maintenance.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "../../output/render.js";
import { daemonReloadSchema, type DaemonReloadResult } from "./reload.js";

const restartCommand = 'paseo daemon restart --home "/selected home"';

function result(data: DaemonReloadResult) {
  return { type: "single" as const, data, schema: daemonReloadSchema };
}

describe("daemon reload output", () => {
  test("human output reports restart and override warnings", () => {
    expect(
      render(
        result({
          restartCommand,
          appliedPaths: ["daemon.browserTools.enabled"],
          restartRequiredPaths: ["daemon.listen"],
          overrideControlledPaths: ["app.baseUrl"],
        }),
      ),
    ).toBe(
      [
        "Configuration reloaded.",
        "",
        "Warning: These changes require a daemon restart:",
        "  daemon.listen",
        "",
        `Run: ${restartCommand}`,
        "",
        "Warning: These settings are controlled by daemon launch overrides:",
        "  app.baseUrl",
      ].join("\n"),
    );
  });

  test("human output omits restart guidance for a live-only reload", () => {
    const output = render(
      result({
        restartCommand,
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      }),
    );
    expect(output).toBe("Configuration reloaded.");
    expect(output).not.toContain("restart");
  });

  test("structured output preserves the daemon result", () => {
    const data = {
      restartCommand,
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    };
    expect(render(result(data), { format: "json" })).toBe(JSON.stringify(data, null, 2));
    expect(render(result(data), { format: "yaml" })).toContain(
      "appliedPaths:\n  - daemon.browserTools.enabled",
    );
  });
});

describe("maintenance CLI contract", () => {
  test("end accepts a private FD and has no token argv option", () => {
    const maintenance = daemonMaintenanceCommand();
    const end = maintenance.commands.find((command) => command.name() === "end")!;
    expect(end.options.some((option) => option.long === "--owner-token-fd")).toBe(true);
    expect(end.options.some((option) => option.long === "--owner-token")).toBe(false);
    const offline = maintenance.commands.find((command) => command.name() === "verify-offline")!;
    expect(
      offline.options.some((option) => ["--home", "--host", "--state"].includes(option.long ?? "")),
    ).toBe(false);
  });
});

describe("maintenance private owner token FD", () => {
  test.each(["x".repeat(43), "x".repeat(43) + "\n"])(
    "accepts exact private token framing",
    (bytes) => {
      const home = mkdtempSync(join(tmpdir(), "maintenance-cli-token-"));
      const path = join(home, "private");
      writeFileSync(path, bytes, { mode: 0o600 });
      const fd = openSync(path, "r");
      try {
        expect(readMaintenanceOwnerToken(fd)).toBe("x".repeat(43));
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
  test.each(["", "x".repeat(42), "x".repeat(44), "x".repeat(43) + "\n\n", "x".repeat(100000)])(
    "rejects malformed or oversized token bytes without echoing them",
    (bytes) => {
      const home = mkdtempSync(join(tmpdir(), "maintenance-cli-invalid-"));
      const path = join(home, "private");
      writeFileSync(path, bytes, { mode: 0o600 });
      const fd = openSync(path, "r");
      try {
        expect(() => readMaintenanceOwnerToken(fd)).toThrow("Invalid maintenance token input");
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});


describe("maintenance BEGIN authoritative refusal output", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(connectToDaemon).mockReset(); });
  test.each(["known", "generic", "contradictory", "lost", "close-failed"])("%s response never logs bearer or guesses busy", async (mode) => {
    const token = "x".repeat(43);
    const maintenanceBegin = vi.fn(async () => {
      if (mode === "lost") throw Object.assign(new Error(token), { code: "MAINTENANCE_KNOWN_BUSY" });
      return { requestId: "begin", error: "refused " + token, result: mode === "contradictory" ? { ownerToken: token } : null,
        ...(mode !== "generic" ? { errorCode: "MAINTENANCE_KNOWN_BUSY" } : {}) };
    });
    const close = vi.fn(async () => { if (mode === "close-failed") throw new Error(token); });
    vi.mocked(connectToDaemon).mockResolvedValue({ maintenanceBegin, close } as unknown as Awaited<ReturnType<typeof connectToDaemon>>);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test exit"); });
    await expect(daemonMaintenanceCommand().parseAsync(["begin", "--generation", "1", "--transaction-id", "tx", "--expected-server-id", "server", "--expected-daemon-incarnation", "incarnation", "--json"], { from: "user" })).rejects.toThrow("test exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(stderr.mock.calls[0][0]));
    expect(output).toEqual({ error: { code: mode === "known" ? "MAINTENANCE_KNOWN_BUSY" : "UNKNOWN_ERROR", message: "Maintenance reservation refused" } });
    expect(JSON.stringify(output)).not.toContain(token);
    expect(maintenanceBegin).toHaveBeenCalledWith({ generation: 1, transactionId: "tx", expectedServerId: "server", expectedDaemonIncarnation: "incarnation" });
  });
  test("text-only refusal cannot produce typed busy", () => {
    expect(maintenanceBeginRefusal({ result: null, error: "MAINTENANCE_KNOWN_BUSY" }).code).toBe("UNKNOWN_ERROR");
  });
});
