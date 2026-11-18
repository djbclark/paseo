import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonMaintenanceCommand, readMaintenanceOwnerToken } from "./maintenance.js";
import { describe, expect, test } from "vitest";
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
  test.each(["x".repeat(43), "x".repeat(43) + "\n"])("accepts exact private token framing", (bytes) => {
    const home = mkdtempSync(join(tmpdir(), "maintenance-cli-token-"));
    const path = join(home, "private");
    writeFileSync(path, bytes, { mode: 0o600 });
    const fd = openSync(path, "r");
    try { expect(readMaintenanceOwnerToken(fd)).toBe("x".repeat(43)); }
    finally { closeSync(fd); rmSync(home, { recursive: true, force: true }); }
  });
  test.each(["", "x".repeat(42), "x".repeat(44), "x".repeat(43) + "\n\n", "x".repeat(100000)])("rejects malformed or oversized token bytes without echoing them", (bytes) => {
    const home = mkdtempSync(join(tmpdir(), "maintenance-cli-invalid-"));
    const path = join(home, "private");
    writeFileSync(path, bytes, { mode: 0o600 });
    const fd = openSync(path, "r");
    try { expect(() => readMaintenanceOwnerToken(fd)).toThrow("Invalid maintenance token input"); }
    finally { closeSync(fd); rmSync(home, { recursive: true, force: true }); }
  });
});
