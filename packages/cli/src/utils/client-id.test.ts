import { afterEach, describe, expect, test, vi } from "vitest";
import * as io from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as daemonControl from "@getpaseo/server/daemon-control";
import { createHostClient } from "@getpaseo/client/node";
import { getOrCreateCliClientId } from "./client-id.js";
import { connectToDaemon } from "./client.js";
import { daemonMaintenanceCommand } from "../commands/daemon/maintenance.js";
import { daemonStatusCommand } from "../commands/daemon/status.js";

// Real filesystem/identity/readiness utilities; only the network transport is synthetic.
vi.mock("node:fs/promises", { spy: true });
vi.mock("@getpaseo/server/daemon-control", { spy: true });
vi.mock("@getpaseo/client/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@getpaseo/client/node")>()),
  createHostClient: vi.fn(),
}));
const disk = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
type IdentityState = "missing" | "empty" | "existing";

async function fixture(state: IdentityState = "missing") {
  const root = await disk.mkdtemp(join(tmpdir(), "cli-identity-observation-"));
  roots.push(root);
  const home = join(root, "home");
  await disk.mkdir(home, { mode: 0o755 });
  await disk.chmod(home, 0o755);
  const path = join(home, "cli-client-id");
  const original = state === "existing" ? "  cid_existing_fixture\n" : " \n\t";
  if (state !== "missing") await disk.writeFile(path, original, { mode: 0o600 });
  const host = `unix://${join(root, "unused-fixture.sock")}`;
  await disk.writeFile(
    join(home, "paseo.pid"),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: "fixture",
      uid: process.getuid?.() ?? 0,
      listen: host,
    }),
  );
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("PASEO_PASSWORD", "");
  const client = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    maintenanceBegin: vi.fn(async () => ({
      error: null,
      result: {
        schemaVersion: 1,
        state: "held",
        generation: 1,
        reservationGeneration: 1,
        transactionId: "fixture",
        recoveryRequired: false,
        ownerToken: "x".repeat(43),
      },
    })),
    maintenanceStatus: vi.fn(async () => ({
      error: null,
      result: {
        schemaVersion: 1,
        state: "idle",
        generation: null,
        transactionId: null,
        recoveryRequired: false,
      },
    })),
    isConnected: true,
    getLastServerInfoMessage: () => ({ serverId: "fixture", version: "fixture" }),
    getDaemonStatus: vi.fn(async () => ({
      version: "fixture",
      pid: process.pid,
      nodePath: process.execPath,
      providers: [],
      relay: null,
    })),
  };
  vi.clearAllMocks();
  vi.mocked(createHostClient).mockReturnValue(
    client as unknown as ReturnType<typeof createHostClient>,
  );
  return { root, home, path, original, client };
}

async function expectUnchanged(
  f: Awaited<ReturnType<typeof fixture>>,
  state: IdentityState,
  entries: string[],
) {
  expect(vi.mocked(io.writeFile)).not.toHaveBeenCalled();
  expect(vi.mocked(daemonControl.ensurePrivateDirectory)).not.toHaveBeenCalled();
  expect((await disk.readdir(f.home)).sort()).toEqual(entries);
  expect((await disk.stat(f.home)).mode & 0o777).toBe(0o755);
  if (state !== "missing") expect(await disk.readFile(f.path, "utf8")).toBe(f.original);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await disk.rm(root, { recursive: true, force: true });
});

describe("CLI local identity persistence", () => {
  test.each(["missing", "empty", "existing"] as const)(
    "nonpersisting real utility preserves %s state",
    async (state) => {
      const f = await fixture(state);
      const entries = (await disk.readdir(f.home)).sort();
      const id = await getOrCreateCliClientId(f.home, { persistClientId: false });
      if (state === "existing") expect(id).toBe("cid_existing_fixture");
      else expect(id).toMatch(/^cid_[0-9a-f]{32}$/);
      await expectUnchanged(f, state, entries);
    },
  );
  test("nonpersisting real utility never creates an absent home", async () => {
    const f = await fixture();
    await disk.rm(f.home, { recursive: true });
    const id = await getOrCreateCliClientId(f.home, { persistClientId: false });
    expect(id).toMatch(/^cid_[0-9a-f]{32}$/);
    await expect(disk.stat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(vi.mocked(io.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(daemonControl.ensurePrivateDirectory)).not.toHaveBeenCalled();
  });
  test("read errors do not become missing identities", async () => {
    const f = await fixture();
    await disk.mkdir(f.path);
    await expect(getOrCreateCliClientId(f.home, { persistClientId: false })).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(vi.mocked(io.writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(daemonControl.ensurePrivateDirectory)).not.toHaveBeenCalled();
  });
  test("ordinary utility still creates a private home and persists its ID", async () => {
    const f = await fixture();
    await disk.rm(f.home, { recursive: true });
    const id = await getOrCreateCliClientId(f.home);
    expect(await disk.readFile(f.path, "utf8")).toBe(id);
    expect((await disk.stat(f.home)).mode & 0o777).toBe(0o700);
    expect((await disk.stat(f.path)).mode & 0o777).toBe(0o600);
    expect(vi.mocked(io.writeFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(daemonControl.ensurePrivateDirectory)).toHaveBeenCalledTimes(1);
  });
  test("ordinary connect still persists identity and invokes real readiness", async () => {
    const f = await fixture();
    const client = await connectToDaemon({ target: { kind: "instance", home: f.home } });
    await client.close();
    const stored = await disk.readFile(f.path, "utf8");
    expect(stored).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(vi.mocked(createHostClient).mock.calls[0]?.[1]?.clientId).toBe(stored);
    expect(vi.mocked(daemonControl.waitForDaemonReady)).toHaveBeenCalledWith(
      f.home,
      expect.any(Object),
    );
    expect(vi.mocked(io.writeFile)).toHaveBeenCalledTimes(1);
  });
  test("actual mutation command retains ordinary persistent identity behavior", async () => {
    const f = await fixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected CLI exit");
    });
    await daemonMaintenanceCommand().parseAsync(
      ["begin", "--home", f.home, "--json", "--generation", "1", "--transaction-id", "fixture"],
      { from: "user" },
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(f.client.maintenanceBegin).toHaveBeenCalledTimes(1);
    const stored = await disk.readFile(f.path, "utf8");
    expect(stored).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(vi.mocked(createHostClient).mock.calls[0]?.[1]?.clientId).toBe(stored);
    expect(vi.mocked(io.writeFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(daemonControl.ensurePrivateDirectory)).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["maintenance", "missing"],
    ["maintenance", "empty"],
    ["maintenance", "existing"],
    ["daemon", "missing"],
    ["daemon", "empty"],
    ["daemon", "existing"],
  ] as const)(
    "actual %s status path preserves %s identity without initialization writes",
    async (command, state) => {
      const f = await fixture(state);
      const entries = (await disk.readdir(f.home)).sort();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("unexpected CLI exit");
      });
      const cli = command === "maintenance" ? daemonMaintenanceCommand() : daemonStatusCommand();
      const args = command === "maintenance" ? ["status"] : [];
      await cli.parseAsync([...args, "--home", f.home, "--json"], { from: "user" });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stderr).not.toHaveBeenCalled();
      expect(f.client.close).toHaveBeenCalledTimes(1);
      expect(vi.mocked(daemonControl.waitForDaemonReady)).toHaveBeenCalledWith(
        f.home,
        expect.any(Object),
      );
      const id = vi.mocked(createHostClient).mock.calls[0]?.[1]?.clientId;
      if (state === "existing") expect(id).toBe("cid_existing_fixture");
      else expect(id).toMatch(/^cid_[0-9a-f]{32}$/);
      await expectUnchanged(f, state, entries);
    },
  );
});
