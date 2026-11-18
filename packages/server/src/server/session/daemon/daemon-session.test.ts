import {
  qualifiedMaintenanceParticipant,
  qualifiedParentExecutionAssertion,
  type PluginMaintenancePort,
  type QualifiedParentExecution,
} from "../../maintenance-participant.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import * as maintenanceFs from "node:fs";
import * as maintenanceOs from "node:os";
import { verifyOfflineMaintenance } from "../../maintenance-offline.js";
import { WorkspaceSetupRuntime } from "../../workspace-setup-runtime.js";
import { AgentManager } from "../../agent/agent-manager.js";
import { MaintenanceReservation, guardMaintenanceMethod } from "../../maintenance-reservation.js";
import {
  mkdtempSync as makeMaintenanceHome,
  readFileSync as readMaintenanceFile,
  rmSync as removeMaintenanceHome,
} from "node:fs";
import { tmpdir as maintenanceTmpdir } from "node:os";
import { join as maintenanceJoin } from "node:path";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
vi.mock("node:fs", { spy: true });
vi.mock("node:os", { spy: true });
const unmockedMaintenanceFs = await vi.importActual<typeof import("node:fs")>("node:fs");
import pino from "pino";
import {
  DaemonSession,
  type DaemonRuntimeConfig,
  type DaemonSessionHost,
} from "./daemon-session.js";
import type { DaemonWebSocketRuntimeDiagnosticSnapshot } from "./diagnostics.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { HubRelationshipManagement } from "../../hub/relationship-controller.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { DaemonConfigReloadResult } from "../../daemon-config-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "daemon-session-test-")));
  tempDirs.push(home);
  return home;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeSubsystem(overrides: {
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  listProviderAvailability?: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  hubRelationships?: HubRelationshipManagement;
  reloadConfig?: () => Promise<DaemonConfigReloadResult>;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const restartIntents: Parameters<DaemonSessionHost["emitLifecycleIntent"]>[0][] = [];
  const host: DaemonSessionHost = {
    emit: (msg) => emitted.push(msg),
    emitLifecycleIntent: (intent) => restartIntents.push(intent),
  };
  const paseoHome = makeHome();
  const subsystem = new DaemonSession({
    host,
    clientId: "client-1",
    paseoHome,
    serverId: overrides.serverId,
    daemonVersion: overrides.daemonVersion,
    daemonRuntimeConfig: overrides.daemonRuntimeConfig,
    listAgents: () => [],
    listProjects: async () => [],
    listWorkspaces: async () => [],
    listProviderAvailability: overrides.listProviderAvailability ?? (async () => []),
    getWebSocketRuntimeMetrics: overrides.getWebSocketRuntimeMetrics,
    hubRelationships: overrides.hubRelationships,
    reloadConfig:
      overrides.reloadConfig ??
      (async () => ({
        appliedPaths: [],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      })),
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted, paseoHome, restartIntents };
}

describe("DaemonSession", () => {
  test("config reload returns the daemon-owned classification", async () => {
    const { subsystem, emitted } = makeSubsystem({
      reloadConfig: async () => ({
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: ["daemon.listen"],
        overrideControlledPaths: ["app.baseUrl"],
      }),
    });

    await subsystem.handleConfigReloadRequest({
      type: "daemon.config.reload.request",
      requestId: "reload-1",
    });

    expect(emitted).toEqual([
      {
        type: "daemon.config.reload.response",
        payload: {
          requestId: "reload-1",
          appliedPaths: ["daemon.browserTools.enabled"],
          restartRequiredPaths: ["daemon.listen"],
          overrideControlledPaths: ["app.baseUrl"],
        },
      },
    ]);
  });

  test("config reload failures return a correlated RPC error", async () => {
    const { subsystem, emitted } = makeSubsystem({
      reloadConfig: async () => {
        throw new Error("Invalid config");
      },
    });

    await subsystem.handleConfigReloadRequest({
      type: "daemon.config.reload.request",
      requestId: "reload-2",
    });

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "reload-2",
          requestType: "daemon.config.reload.request",
          error: "Invalid config",
          code: "handler_error",
        },
      },
    ]);
  });
  test("Hub relationship command failures return correlated RPC errors", async () => {
    const { subsystem, emitted } = makeSubsystem({
      hubRelationships: {
        connect: async () => {
          throw new Error("Hub rejected enrollment (401)");
        },
        status: () => ({
          state: "not_connected",
          daemonId: null,
          hubOrigin: null,
          scopes: [],
          connectedAt: null,
          lastError: null,
        }),
        disconnect: async () => {
          throw new Error("Hub revocation failed (503)");
        },
      },
    });

    await subsystem.handleHubRelationshipRequest({
      type: "hub.management.daemon.connect.request",
      requestId: "connect-1",
      hubUrl: "https://hub.test",
      token: "token",
    });
    await subsystem.handleHubRelationshipRequest({
      type: "hub.management.daemon.disconnect.request",
      requestId: "disconnect-1",
      force: false,
    });

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "connect-1",
          requestType: "hub.management.daemon.connect.request",
          error: "Hub rejected enrollment (401)",
          code: "handler_error",
        },
      },
      {
        type: "rpc_error",
        payload: {
          requestId: "disconnect-1",
          requestType: "hub.management.daemon.disconnect.request",
          error: "Hub revocation failed (503)",
          code: "handler_error",
        },
      },
    ]);
  });

  test("status reports identity, runtime config, and providers with errors normalized to null", async () => {
    const { subsystem, emitted } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", getRelayConfig: () => null },
      listProviderAvailability: async () => [
        { provider: "claude", available: true, error: null },
        { provider: "codex", available: false, error: "boom" },
      ],
    });

    await subsystem.handleGetStatusRequest({ type: "daemon.get_status.request", requestId: "s-1" });

    expect(emitted).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "s-1",
          serverId: "srv-1",
          version: "1.2.3",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: "127.0.0.1:6767",
          relay: null,
          providers: [
            { provider: "claude", available: true, error: null },
            { provider: "codex", available: false, error: "boom" },
          ],
          terminalCleanupUnconfirmed: [],
        },
      },
    ]);
  });

  test("status falls back to null fields and an empty provider list when listing rejects", async () => {
    const { subsystem, emitted } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", getRelayConfig: () => null },
      listProviderAvailability: async () => {
        throw new Error("provider listing failed");
      },
    });

    await subsystem.handleGetStatusRequest({ type: "daemon.get_status.request", requestId: "s-2" });

    expect(emitted).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "s-2",
          serverId: "srv-1",
          version: "1.2.3",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
          terminalCleanupUnconfirmed: [],
        },
      },
    ]);
  });

  test("pairing offer is empty when relay is disabled", async () => {
    const { subsystem, emitted } = makeSubsystem({
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        getRelayConfig: () => ({
          enabled: false,
          endpoint: "relay.paseo.sh:443",
          publicEndpoint: "relay.paseo.sh:443",
          useTls: true,
          publicUseTls: true,
        }),
      },
    });

    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "p-1",
    });

    expect(emitted).toEqual([
      {
        type: "daemon.get_pairing_offer.response",
        payload: { requestId: "p-1", url: "", qr: null, relayEnabled: false },
      },
    ]);
  });

  test("pairing offer mints a real connection URL when relay is enabled", async () => {
    const { subsystem, emitted } = makeSubsystem({
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        appBaseUrl: "https://app.example.test",
        getRelayConfig: () => ({
          enabled: true,
          endpoint: "relay.example.test:443",
          publicEndpoint: "relay.example.test:443",
          useTls: true,
          publicUseTls: true,
        }),
      },
    });

    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "p-2",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("daemon.get_pairing_offer.response");
    if (message.type !== "daemon.get_pairing_offer.response") {
      throw new Error("expected a pairing offer response");
    }
    expect(message.payload.requestId).toBe("p-2");
    expect(message.payload.relayEnabled).toBe(true);
    expect(message.payload.url.startsWith("https://app.example.test")).toBe(true);
    expect(typeof message.payload.qr).toBe("string");
  });

  test("pairing offer reads relay state at request time", async () => {
    let enabled = false;
    const { subsystem, emitted } = makeSubsystem({
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        appBaseUrl: "https://app.example.test",
        getRelayConfig: () => ({
          enabled,
          endpoint: "relay.example.test:443",
          publicEndpoint: "relay.example.test:443",
          useTls: true,
          publicUseTls: true,
        }),
      },
    });

    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "disabled",
    });
    enabled = true;
    await subsystem.handleGetPairingOfferRequest({
      type: "daemon.get_pairing_offer.request",
      requestId: "enabled",
    });

    const pairingResponses = emitted.filter(
      (message) => message.type === "daemon.get_pairing_offer.response",
    );
    expect(pairingResponses[0]?.payload.relayEnabled).toBe(false);
    expect(pairingResponses[1]?.payload.relayEnabled).toBe(true);
    expect(pairingResponses[1]?.payload.url).toContain("#offer=");
  });

  test("diagnostics includes a log tail and redacts connection secrets", async () => {
    const { subsystem, emitted, paseoHome } = makeSubsystem({
      serverId: "srv-1",
      daemonVersion: "1.2.3",
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        getRelayConfig: () => ({
          enabled: true,
          endpoint: "relay.secret.test:443",
          publicEndpoint: "relay.secret.test:443",
          useTls: true,
          publicUseTls: true,
        }),
      },
    });
    writeFileSync(
      join(paseoHome, "daemon.log"),
      "first line\nrelay.secret.test:443 token=super-secret paseo://pairing-secret\n",
    );

    await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-1" });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("diagnostics.response");
    if (message.type !== "diagnostics.response") {
      throw new Error("expected diagnostics response");
    }
    expect(message.payload.requestId).toBe("d-1");
    expect(message.payload.diagnostic).toContain("Daemon log tail");
    expect(message.payload.diagnostic).toContain("first line");
    expect(message.payload.diagnostic).not.toContain("relay.secret.test:443");
    expect(message.payload.diagnostic).not.toContain("super-secret");
    expect(message.payload.diagnostic).not.toContain("pairing-secret");
  });

  test("diagnostics includes the PATH and shell visible to the daemon", async () => {
    const originalPath = process.env.PATH;
    const originalShell = process.env.SHELL;
    const originalComSpec = process.env.ComSpec;
    const originalCOMSPEC = process.env.COMSPEC;
    try {
      process.env.PATH = "/opt/paseo-test/bin:/usr/bin";
      process.env.SHELL = "/bin/paseo-test-shell";
      delete process.env.ComSpec;
      delete process.env.COMSPEC;

      const { subsystem, emitted } = makeSubsystem({});

      await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-env" });

      expect(emitted).toHaveLength(1);
      const message = emitted[0];
      expect(message.type).toBe("diagnostics.response");
      if (message.type !== "diagnostics.response") {
        throw new Error("expected diagnostics response");
      }
      expect(message.payload.diagnostic).toContain("PATH: /opt/paseo-test/bin:/usr/bin");
      expect(message.payload.diagnostic).toContain("Shell: SHELL=/bin/paseo-test-shell");
    } finally {
      restoreEnv("PATH", originalPath);
      restoreEnv("SHELL", originalShell);
      restoreEnv("ComSpec", originalComSpec);
      restoreEnv("COMSPEC", originalCOMSPEC);
    }
  });

  test("diagnostics includes the last flushed websocket runtime metrics", async () => {
    const { subsystem, emitted } = makeSubsystem({
      getWebSocketRuntimeMetrics: () => ({
        collectedAt: "2026-01-02T03:04:05.000Z",
        windowMs: 30_000,
        uptimeSeconds: 12.345,
        memory: {
          rss: 1024 * 1024 * 64,
          heapTotal: 1024 * 1024 * 32,
          heapUsed: 1024 * 1024 * 12,
          external: 1024 * 1024 * 3,
          arrayBuffers: 1024 * 512,
        },
        final: false,
        sessions: {
          activeConnections: 2,
          externalSessionKeys: 3,
          reconnectGraceSessions: 1,
        },
        sockets: {
          activeSockets: 2,
          pendingConnections: 1,
        },
        counters: {
          connectedAwaitingHello: 1,
          helloResumed: 0,
          helloNew: 2,
          pendingDisconnected: 0,
          sessionDisconnectedWaitingReconnect: 0,
          sessionSocketDisconnectedAttached: 0,
          sessionCleanup: 0,
          validationFailed: 0,
          binaryBeforeHelloRejected: 0,
          pendingMessageRejectedBeforeHello: 0,
          missingConnectionForMessage: 0,
          unexpectedHelloOnActiveConnection: 0,
          relayExternalSocketAttached: 0,
          originRejected: 0,
          hostRejected: 0,
        },
        inboundMessageTypesTop: [["session", 4]],
        inboundSessionRequestTypesTop: [["diagnostics.request", 2]],
        outboundMessageTypesTop: [["session_message", 5]],
        outboundSessionMessageTypesTop: [["diagnostics.response", 2]],
        outboundAgentStreamTypesTop: [["timeline:message", 3]],
        outboundAgentStreamAgentsTop: [["agent-1", 3]],
        outboundBinaryFrameTypesTop: [["binary", 1]],
        bufferedAmount: {
          p95: 128,
          max: 256,
        },
        eventLoopDelay: {
          p50Ms: 1,
          p99Ms: 4,
          maxMs: 7,
        },
        runtime: {
          inflightRequests: 1,
          peakInflightRequests: 3,
          terminalSubscriptionCount: 4,
          terminalDirectorySubscriptionCount: 5,
          checkoutDiffTargetCount: 6,
          checkoutDiffSubscriptionCount: 7,
          checkoutDiffWatcherCount: 8,
          checkoutDiffFallbackRefreshTargetCount: 9,
        },
        latency: [
          {
            type: "diagnostics.request",
            count: 2,
            minMs: 3,
            maxMs: 7,
            p50Ms: 4,
            totalMs: 11,
          },
        ],
        agents: {
          total: 10,
          byLifecycle: {
            idle: 8,
            running: 2,
          },
          withActiveForegroundTurn: 2,
          timelineStats: {
            totalItems: 42,
            maxItemsPerAgent: 12,
          },
        },
      }),
    });

    await subsystem.handleDiagnosticsRequest({ type: "diagnostics.request", requestId: "d-2" });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    expect(message.type).toBe("diagnostics.response");
    if (message.type !== "diagnostics.response") {
      throw new Error("expected diagnostics response");
    }
    expect(message.payload.diagnostic).toContain("WebSocket runtime metrics");
    expect(message.payload.diagnostic).toContain("Collected at: 2026-01-02T03:04:05.000Z");
    expect(message.payload.diagnostic).toContain("Process uptime: 12s");
    expect(message.payload.diagnostic).toContain(
      "Process memory: rss=64.0 MiB, heap=12.0 MiB / 32.0 MiB",
    );
    expect(message.payload.diagnostic).toContain(
      "Sessions: active=2, externalKeys=3, reconnectGrace=1",
    );
    expect(message.payload.diagnostic).toContain(
      "Latency: diagnostics.request count=2 p50=4ms max=7ms total=11ms",
    );
    expect(message.payload.diagnostic).toContain("Inbound session requests: diagnostics.request=2");
    expect(message.payload.diagnostic).toContain(
      "Checkout diff: targets=6, subscriptions=7, watchers=8, fallbackRefreshTargets=9",
    );
    expect(message.payload.diagnostic).toContain("Agent lifecycle: idle=8, running=2");
  });
});

describe("maintenance reservation admission", () => {
  function fixture(quiet: () => Promise<boolean> = async () => true) {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "maintenance-"));
    const reservation = new MaintenanceReservation(home, quiet);
    return {
      home,
      reservation,
      close: () => removeMaintenanceHome(home, { recursive: true, force: true }),
    };
  }
  test("persists only ownership digest, survives restart indefinitely, requires token and generation", async () => {
    const f = fixture();
    try {
      const held = await f.reservation.begin(1, "transaction");
      const persisted = readMaintenanceFile(
        maintenanceJoin(f.home, "maintenance-reservation.json"),
        "utf8",
      );
      expect(persisted).not.toContain(held.ownerToken);
      expect(JSON.stringify(f.reservation.status())).not.toContain(held.ownerToken);
      const restarted = new MaintenanceReservation(f.home, async () => true);
      expect(restarted.status().state).toBe("recovery-required");
      expect(() => restarted.enter()).toThrow();
      await expect(restarted.end(2, held.ownerToken)).rejects.toThrow();
      await expect(restarted.end(1, "wrong")).rejects.toThrow();
      expect((await restarted.end(1, held.ownerToken)).state).toBe("idle");
      await expect(restarted.begin(1, "reused")).rejects.toThrow();
      expect((await restarted.begin(2, "new")).state).toBe("held");
    } finally {
      f.close();
    }
  });
  test("serializes shared internal admission and never cancels existing work", async () => {
    const f = fixture();
    let finish!: () => void;
    const owner = {
      execute: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    guardMaintenanceMethod(owner, "execute", f.reservation);
    try {
      const existing = owner.execute();
      await expect(f.reservation.begin(1, "busy")).rejects.toThrow();
      finish();
      await existing;
      await f.reservation.begin(1, "quiet");
      await expect(owner.execute()).rejects.toThrow();
    } finally {
      f.close();
    }
  });
  test("closes admission before awaiting observation, rejecting simultaneous begin and new work", async () => {
    let observed!: (quiet: boolean) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          observed = resolve;
        }),
    );
    try {
      const grant = f.reservation.begin(1, "first");
      expect(() => f.reservation.enter()).toThrow();
      expect(f.reservation.status().state).toBe("held");
      await expect(f.reservation.begin(2, "second")).rejects.toThrow();
      observed(false);
      await expect(grant).rejects.toThrow();
      const release = f.reservation.enter();
      release();
      release();
    } finally {
      f.close();
    }
  });
  test("direct internal manager calls share the held admission owner", async () => {
    const f = fixture();
    const manager = new AgentManager({
      logger: pino({ level: "silent" }),
      clients: createTestAgentClients(),
    });
    manager.installMaintenanceReservation(f.reservation);
    try {
      await f.reservation.begin(1, "internal-call");
      await expect(
        manager.createAgent({ provider: "codex", cwd: f.home }, undefined, {}),
      ).rejects.toThrow("maintenance");
      await expect(manager.streamAgent("unloaded-agent", "prompt").next()).rejects.toThrow(
        "maintenance",
      );
      await expect(manager.steerOrReplaceActiveTurn("unloaded-agent", "prompt")).rejects.toThrow(
        "maintenance",
      );
      await expect(
        manager.listDraftCommands({ provider: "codex", cwd: f.home, model: "test-model" }),
      ).rejects.toThrow("maintenance");
      expect(await manager.listDraftControls({ provider: "codex", cwd: f.home })).toMatchObject({
        controls: [],
      });
    } finally {
      f.close();
    }
  });
  test("unknown observation fails closed without granting or expiring a hold", async () => {
    const f = fixture(async () => {
      throw new Error("unknown");
    });
    try {
      await expect(f.reservation.begin(1, "unknown")).rejects.toThrow();
      expect(f.reservation.status().state).toBe("recovery-required");
      expect(() => f.reservation.enter()).toThrow();
      const restarted = new MaintenanceReservation(f.home, async () => true);
      expect(restarted.status().state).toBe("recovery-required");
      expect(() => restarted.enter()).toThrow();
    } finally {
      f.close();
    }
  });
});

describe("maintenance filesystem failure and restart commit points", () => {
  const stages = [
    "temp-open",
    "write",
    "file-fsync",
    "file-close",
    "rename",
    "directory-open",
    "directory-fsync",
    "directory-close",
  ] as const;
  function resetFaults() {
    for (const method of [
      maintenanceFs.openSync,
      maintenanceFs.writeFileSync,
      maintenanceFs.fsyncSync,
      maintenanceFs.closeSync,
      maintenanceFs.renameSync,
    ])
      vi.mocked(method).mockReset();
  }
  function inject(stage: (typeof stages)[number]) {
    let injected = false;
    const fail = (matches: boolean) => {
      if (matches && !injected) {
        injected = true;
        throw new Error(`injected ${stage}`);
      }
    };
    vi.mocked(maintenanceFs.openSync).mockImplementation((...args) => {
      fail(
        (stage === "temp-open" && args[1] === "wx") ||
          (stage === "directory-open" && args[1] === "r"),
      );
      return unmockedMaintenanceFs.openSync(...args);
    });
    vi.mocked(maintenanceFs.writeFileSync).mockImplementation((...args) => {
      fail(stage === "write");
      return unmockedMaintenanceFs.writeFileSync(...args);
    });
    vi.mocked(maintenanceFs.fsyncSync).mockImplementation((fd) => {
      const directory = unmockedMaintenanceFs.fstatSync(fd).isDirectory();
      fail((stage === "file-fsync" && !directory) || (stage === "directory-fsync" && directory));
      return unmockedMaintenanceFs.fsyncSync(fd);
    });
    vi.mocked(maintenanceFs.closeSync).mockImplementation((fd) => {
      const directory = unmockedMaintenanceFs.fstatSync(fd).isDirectory();
      fail((stage === "file-close" && !directory) || (stage === "directory-close" && directory));
      return unmockedMaintenanceFs.closeSync(fd);
    });
    vi.mocked(maintenanceFs.renameSync).mockImplementation((...args) => {
      fail(stage === "rename");
      return unmockedMaintenanceFs.renameSync(...args);
    });
  }
  test.each(stages)(
    "begin %s fails closed; restart reads stable committed authority",
    async (stage) => {
      const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "begin-fault-"));
      try {
        const reservation = new MaintenanceReservation(home, async () => true);
        const previous = await reservation.begin(1, "previous");
        await reservation.end(1, previous.ownerToken);
        inject(stage);
        await expect(reservation.begin(2, "failed-begin")).rejects.toThrow("injected");
        expect(reservation.status()).toMatchObject({
          state: "recovery-required",
          recoveryRequired: true,
        });
        expect(() => reservation.enter()).toThrow();
        resetFaults();
        const restarted = new MaintenanceReservation(home, async () => true);
        const renamed = stage.startsWith("directory-");
        expect(restarted.status().state).toBe(renamed ? "recovery-required" : "idle");
        expect(restarted.status().generation).toBe(renamed ? 2 : 1);
      } finally {
        resetFaults();
        removeMaintenanceHome(home, { recursive: true, force: true });
      }
    },
  );
  test.each(stages)(
    "end %s fails closed; valid renamed idle is the authorized release commit",
    async (stage) => {
      const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "end-fault-"));
      try {
        const reservation = new MaintenanceReservation(home, async () => true);
        const held = await reservation.begin(1, "held");
        inject(stage);
        await expect(reservation.end(1, held.ownerToken)).rejects.toThrow("injected");
        expect(reservation.status()).toMatchObject({
          state: "recovery-required",
          recoveryRequired: true,
        });
        expect(() => reservation.enter()).toThrow();
        resetFaults();
        const restarted = new MaintenanceReservation(home, async () => true);
        expect(restarted.status().state).toBe(
          stage.startsWith("directory-") ? "idle" : "recovery-required",
        );
      } finally {
        resetFaults();
        removeMaintenanceHome(home, { recursive: true, force: true });
      }
    },
  );
  test("fresh differs from established missing authority; dangling and ENOTDIR cannot mean fresh", async () => {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "authority-missing-"));
    try {
      const reservation = new MaintenanceReservation(home, async () => true);
      expect(reservation.status().state).toBe("idle");
      await reservation.begin(1, "established");
      const path = maintenanceJoin(home, "maintenance-reservation.json");
      maintenanceFs.unlinkSync(path);
      expect(() => new MaintenanceReservation(home, async () => true)).toThrow("missing");
      maintenanceFs.symlinkSync(maintenanceJoin(home, "absent"), path);
      expect(() => new MaintenanceReservation(home, async () => true)).toThrow();
      const nonDirectory = maintenanceJoin(home, "file");
      maintenanceFs.writeFileSync(nonDirectory, "file");
      expect(
        () => new MaintenanceReservation(maintenanceJoin(nonDirectory, "child"), async () => true),
      ).toThrow();
    } finally {
      removeMaintenanceHome(home, { recursive: true, force: true });
    }
  });
  test("EACCES is never treated as fresh authority", () => {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "authority-access-"));
    try {
      vi.mocked(maintenanceFs.lstatSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
      expect(() => new MaintenanceReservation(home, async () => true)).toThrow("denied");
    } finally {
      vi.mocked(maintenanceFs.lstatSync).mockReset();
      removeMaintenanceHome(home, { recursive: true, force: true });
    }
  });
  test("enrollment committed before a first-record failure prevents restart treating home as fresh", async () => {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "enrollment-fault-"));
    try {
      const reservation = new MaintenanceReservation(home, async () => true);
      inject("directory-fsync");
      await expect(reservation.begin(1, "first")).rejects.toThrow();
      expect(reservation.status().state).toBe("recovery-required");
      resetFaults();
      expect(() => new MaintenanceReservation(home, async () => true)).toThrow("missing");
    } finally {
      resetFaults();
      removeMaintenanceHome(home, { recursive: true, force: true });
    }
  });
});

describe("protected offline maintenance authority", () => {
  const account = maintenanceOs.userInfo();
  function fixture() {
    const home = makeMaintenanceHome(maintenanceJoin(account.homedir, "maintenance-proof-"));
    const directory = maintenanceJoin(home, ".paseo");
    maintenanceFs.mkdirSync(directory, { mode: 0o700 });
    maintenanceFs.writeFileSync(
      maintenanceJoin(directory, "maintenance-enrollment.json"),
      JSON.stringify({ schemaVersion: 1, component: "paseo-maintenance" }),
      { mode: 0o600 },
    );
    const path = maintenanceJoin(directory, "maintenance-reservation.json");
    const record = {
      schemaVersion: 1,
      generation: 7,
      transactionId: "protected-journal",
      tokenDigest: "a".repeat(64),
    };
    maintenanceFs.writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    vi.mocked(maintenanceOs.userInfo).mockReturnValue({ ...account, homedir: home });
    return {
      home,
      directory,
      path,
      record,
      verify: () => verifyOfflineMaintenance(7, "protected-journal"),
      close: () => {
        vi.mocked(maintenanceOs.userInfo).mockReset();
        vi.mocked(maintenanceFs.readSync).mockReset();
        vi.restoreAllMocks();
        removeMaintenanceHome(home, { recursive: true, force: true });
      },
    };
  }
  test("accepts only matching protected persisted hold and returns no digest/token", () => {
    const f = fixture();
    try {
      expect(f.verify()).toEqual({
        schemaVersion: 1,
        generation: 7,
        transactionId: "protected-journal",
        state: "recovery-required",
        recoveryRequired: true,
      });
      expect(() => verifyOfflineMaintenance(8, "protected-journal")).toThrow();
      expect(() => verifyOfflineMaintenance(7, "candidate-transaction")).toThrow();
      maintenanceFs.writeFileSync(f.path, JSON.stringify({ ...f.record, tokenDigest: null }));
      expect(f.verify).toThrow();
    } finally {
      f.close();
    }
  });
  test("rejects writable directories and readable records", () => {
    const f = fixture();
    try {
      maintenanceFs.chmodSync(f.directory, 0o777);
      expect(f.verify).toThrow();
      maintenanceFs.chmodSync(f.directory, 0o700);
      maintenanceFs.chmodSync(f.path, 0o644);
      expect(f.verify).toThrow();
    } finally {
      f.close();
    }
  });
  test("rejects record ownership mismatch and size instability", () => {
    const f = fixture();
    try {
      vi.mocked(maintenanceFs.fstatSync).mockImplementationOnce(((
        ...args: Parameters<typeof maintenanceFs.fstatSync>
      ) => {
        const stat = unmockedMaintenanceFs.fstatSync(...args);
        return Object.assign(stat, { uid: account.uid + 1 });
      }) as typeof maintenanceFs.fstatSync);
      expect(f.verify).toThrow();
      vi.mocked(maintenanceFs.fstatSync).mockReset();
      maintenanceFs.writeFileSync(f.path, "x".repeat(4097));
      expect(f.verify).toThrow();
    } finally {
      vi.mocked(maintenanceFs.fstatSync).mockReset();
      f.close();
    }
  });
  test("rejects final symlinks, ancestor symlinks and hardlinked authority", () => {
    const f = fixture();
    try {
      const original = maintenanceJoin(f.home, "original");
      maintenanceFs.renameSync(f.path, original);
      maintenanceFs.symlinkSync(original, f.path);
      expect(f.verify).toThrow();
      maintenanceFs.unlinkSync(f.path);
      maintenanceFs.linkSync(original, f.path);
      expect(f.verify).toThrow();
      maintenanceFs.unlinkSync(f.path);
      maintenanceFs.renameSync(original, f.path);
      const previous = maintenanceJoin(f.home, "previous");
      maintenanceFs.renameSync(f.directory, previous);
      maintenanceFs.symlinkSync(previous, f.directory);
      expect(f.verify).toThrow();
    } finally {
      f.close();
    }
  });
  test("rejects unknown schema, digest and candidate-added approval fields", () => {
    const f = fixture();
    try {
      for (const record of [
        { ...f.record, schemaVersion: 2 },
        { ...f.record, tokenDigest: "not-a-digest" },
        { ...f.record, approved: true },
      ]) {
        maintenanceFs.writeFileSync(f.path, JSON.stringify(record));
        expect(f.verify).toThrow();
      }
    } finally {
      f.close();
    }
  });
  test("ignores HOME override, rejects missing enrollment/established record and nonregular FIFO promptly", async () => {
    const f = fixture();
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = "/candidate-controlled-home";
      expect(f.verify().generation).toBe(7);
      maintenanceFs.unlinkSync(maintenanceJoin(f.directory, "maintenance-enrollment.json"));
      expect(f.verify).toThrow();
      maintenanceFs.writeFileSync(
        maintenanceJoin(f.directory, "maintenance-enrollment.json"),
        JSON.stringify({ schemaVersion: 1, component: "paseo-maintenance" }),
        { mode: 0o600 },
      );
      maintenanceFs.unlinkSync(f.path);
      expect(f.verify).toThrow();
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [f.path], { timeout: 1000 });
      const opened = vi.mocked(maintenanceFs.openSync).mock.calls.length;
      expect(f.verify).toThrow("Nonregular");
      expect(vi.mocked(maintenanceFs.openSync).mock.calls.length).toBe(opened + 1); // Enrollment alone opened; FIFO never opened.
    } finally {
      restoreEnv("HOME", previousHome);
      f.close();
    }
  }, 2000);
  test("rejects record replacement during read", () => {
    const f = fixture();
    try {
      vi.mocked(maintenanceFs.readSync).mockImplementation(((
        ...args: Parameters<typeof maintenanceFs.readSync>
      ) => {
        const bytes = unmockedMaintenanceFs.readSync(...args);
        if (
          !Buffer.from(args[1].buffer, args[1].byteOffset, args[1].byteLength)
            .toString("utf8")
            .includes("tokenDigest")
        )
          return bytes;
        maintenanceFs.unlinkSync(f.path);
        maintenanceFs.writeFileSync(f.path, JSON.stringify(f.record), { mode: 0o600 });
        return bytes;
      }) as typeof maintenanceFs.readSync);
      expect(f.verify).toThrow();
    } finally {
      f.close();
    }
  });
  test("rejects a protected ancestor replaced during read", () => {
    const f = fixture();
    try {
      vi.mocked(maintenanceFs.readSync).mockImplementation(((
        ...args: Parameters<typeof maintenanceFs.readSync>
      ) => {
        const bytes = unmockedMaintenanceFs.readSync(...args);
        if (
          !Buffer.from(args[1].buffer, args[1].byteOffset, args[1].byteLength)
            .toString("utf8")
            .includes("tokenDigest")
        )
          return bytes;
        const previous = maintenanceJoin(f.home, "previous");
        maintenanceFs.renameSync(f.directory, previous);
        maintenanceFs.mkdirSync(f.directory, { mode: 0o700 });
        maintenanceFs.renameSync(maintenanceJoin(previous, "maintenance-reservation.json"), f.path);
        return bytes;
      }) as typeof maintenanceFs.readSync);
      expect(f.verify).toThrow();
    } finally {
      f.close();
    }
  });
});

describe("shared workspace setup maintenance admission", () => {
  test("tracks setup across awaits, then refuses a direct internal start while held", async () => {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "setup-maintenance-"));
    const reservation = new MaintenanceReservation(home, async () => true);
    const setup = new WorkspaceSetupRuntime(reservation);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    try {
      setup.start("workspace", async () => {
        started();
        await completion;
      });
      await began;
      await expect(reservation.begin(1, "active-setup")).rejects.toThrow();
      complete();
      await setup.stop("workspace");
      await reservation.begin(1, "setup-finished");
      let ran = false;
      expect(() =>
        setup.start("new-workspace", async () => {
          ran = true;
        }),
      ).toThrow("maintenance");
      expect(ran).toBe(false);
    } finally {
      complete?.();
      await setup.stop("workspace");
      removeMaintenanceHome(home, { recursive: true, force: true });
    }
  });
});

// Participant mechanism units only. These stubs are never production qualification evidence.
describe("native maintenance participant serialization", () => {
  function fixture(port: PluginMaintenancePort, quiet = async () => true) {
    const home = makeMaintenanceHome(maintenanceJoin(maintenanceTmpdir(), "participant-"));
    return {
      home,
      reservation: new MaintenanceReservation(home, quiet, port),
      close: () => removeMaintenanceHome(home, { recursive: true, force: true }),
    };
  }
  test("known participant busy reopens only an unpublished attempt", async () => {
    const end = vi.fn(async () => {});
    const f = fixture({ supportsV1: () => true, begin: async () => "known-busy", end });
    try {
      await expect(f.reservation.begin(1, "busy")).rejects.toThrow();
      expect(f.reservation.status().state).toBe("idle");
      expect(end).not.toHaveBeenCalled();
      f.reservation.enter()();
    } finally {
      f.close();
    }
  });
  test("authoritative busy rolls back provisional barrier; rollback uncertainty stays held", async () => {
    let fail = false;
    const end = vi.fn(async () => {
      if (fail) throw new Error("lost rollback ACK");
    });
    const f = fixture(
      { supportsV1: () => true, begin: async () => "held", end },
      async () => false,
    );
    try {
      await expect(f.reservation.begin(1, "busy")).rejects.toThrow();
      expect(end).toHaveBeenCalledWith({ generation: 1, transactionId: "busy" });
      expect(f.reservation.status().state).toBe("idle");
      fail = true;
      await expect(f.reservation.begin(1, "uncertain")).rejects.toThrow();
      expect(f.reservation.status().state).toBe("recovery-required");
      expect(() => f.reservation.enter()).toThrow();
      expect(new MaintenanceReservation(f.home, async () => true).status().state).toBe(
        "recovery-required",
      );
    } finally {
      f.close();
    }
  });
  test("unknown/late cohort acknowledgement never returns an owner token or releases the barrier", async () => {
    const begin = vi
      .fn<PluginMaintenancePort["begin"]>()
      .mockResolvedValueOnce("held")
      .mockResolvedValueOnce("unknown");
    const end = vi.fn(async () => {});
    const f = fixture({ supportsV1: () => true, begin, end });
    try {
      await expect(f.reservation.begin(1, "changed-cohort")).rejects.toThrow();
      expect(end).not.toHaveBeenCalled();
      expect(f.reservation.status()).toMatchObject({
        state: "recovery-required",
        recoveryRequired: true,
      });
    } finally {
      f.close();
    }
  });
  test("owner END serializes fresh cohort check, idle commit and participant release without leaking token", async () => {
    const calls: unknown[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const port: PluginMaintenancePort = {
      supportsV1: () => true,
      begin: async (identity) => {
        calls.push({ begin: identity });
        return "held";
      },
      end: async (identity) => {
        calls.push({ end: identity });
        await gate;
      },
    };
    const f = fixture(port);
    try {
      const held = await f.reservation.begin(1, "owner");
      const count = calls.length;
      await expect(f.reservation.end(2, held.ownerToken)).rejects.toThrow();
      await expect(f.reservation.end(1, "wrong")).rejects.toThrow();
      expect(calls).toHaveLength(count);
      const releasing = f.reservation.end(1, held.ownerToken);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.reservation.status().state).toBe("held");
      await expect(f.reservation.begin(2, "racing-begin")).rejects.toThrow();
      expect(JSON.stringify(calls)).not.toContain(held.ownerToken);
      finish();
      expect((await releasing).state).toBe("idle");
    } finally {
      finish();
      f.close();
    }
  });
  test("participant END uncertainty closes current process; restart honors actual authorized idle commit", async () => {
    const f = fixture({
      supportsV1: () => true,
      begin: async () => "held",
      end: async () => {
        throw new Error("release ACK lost");
      },
    });
    try {
      const held = await f.reservation.begin(1, "end-unknown");
      await expect(f.reservation.end(1, held.ownerToken)).rejects.toThrow();
      expect(f.reservation.status().state).toBe("recovery-required");
      expect(() => f.reservation.enter()).toThrow();
      expect(new MaintenanceReservation(f.home, async () => true).status().state).toBe("idle");
    } finally {
      f.close();
    }
  });
  test("restored hold installs barrier before initialization and never automatically ENDs", async () => {
    const calls: string[] = [];
    const port: PluginMaintenancePort = {
      supportsV1: () => true,
      begin: async () => {
        calls.push("barrier");
        return "held";
      },
      end: async () => {
        calls.push("end");
      },
    };
    const f = fixture(port);
    try {
      const owner = await f.reservation.begin(1, "restart");
      calls.length = 0;
      const restored = new MaintenanceReservation(f.home, async () => true, port);
      restored.setReady(false);
      await restored.restoreParticipantBeforeStart();
      await restored.runQualifiedInitialization(async () => {
        calls.push("init");
        expect(() => restored.enter()).toThrow();
      });
      await restored.recheckRestoredParticipant();
      expect(calls).toEqual(["barrier", "init", "barrier"]);
      restored.setReady(true);
      await restored.end(1, owner.ownerToken);
      expect(calls.at(-1)).toBe("end");
    } finally {
      f.close();
    }
  });
  test("missing/fake parent capability is unsupported while raw restore barrier still installs", async () => {
    const rawBegin = vi.fn<PluginMaintenancePort["begin"]>().mockResolvedValue("held");
    const rawEnd = vi.fn(async () => {});
    const raw = { supportsV1: () => true, begin: rawBegin, end: rawEnd };
    const fakeBinding = {
      capability: { assertQualifiedExecution: () => {}, evidenceDigest: "candidate" },
      expectedClosure: "candidate",
      expectedIncarnation: "candidate",
    };
    const fake: QualifiedParentExecution = {
      supervisor: fakeBinding,
      daemon: fakeBinding,
      compiler: fakeBinding,
    };
    for (const chain of [undefined, fake]) {
      const assert = await qualifiedParentExecutionAssertion(chain);
      const participant = qualifiedMaintenanceParticipant(raw, assert);
      expect(participant.supportsV1()).toBe(false);
      expect(await participant.begin({ generation: 1, transactionId: "restore" })).toBe("unknown");
      await expect(participant.end({ generation: 1, transactionId: "restore" })).rejects.toThrow();
    }
    expect(rawBegin).toHaveBeenCalledTimes(2);
    expect(rawEnd).not.toHaveBeenCalled();
  });
});
