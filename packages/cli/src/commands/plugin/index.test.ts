import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const listPlugins = vi.fn(async () => [
  {
    id: "git-plugin",
    path: "/plugins/git-plugin",
    enabled: true,
    status: "running" as const,
    source: "git" as const,
    commit: "1557a34c91e2abcdef",
    ref: "main",
    installation: {
      identity: {
        kind: "git" as const,
        remote: "https://example.test/plugin.git",
        pluginPath: ".",
      },
      currentRevision: "1557a34c91e2abcdef",
    },
  },
  {
    id: "legacy-plugin",
    path: "/plugins/legacy-plugin",
    enabled: true,
    status: "failed" as const,
    error: "This plugin was made for an older version of Paseo",
  },
]);
const getPluginLogs = vi.fn(async () => [
  {
    sequence: 1,
    timestamp: "2026-08-16T12:00:00.000Z",
    stream: "stdout" as const,
    message: "ready",
  },
]);
const installPluginSource = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const installDirectoryPlugin = vi.fn(async () => ({
  id: "legacy-plugin",
  path: "/plugins/legacy-plugin",
  enabled: true,
  status: "running" as const,
}));
const previewPluginUpdates = vi.fn(async () => []);
const close = vi.fn(async () => undefined);
const recoverPlugin = vi.fn(async () => ({
  id: "managed",
  path: "/snapshots/old",
  enabled: true,
  status: "running" as const,
}));

const getManagedPluginStatus = vi.fn(async () => ({
  version: 1 as const,
  pluginId: "managed",
  consistency: "uncertain" as const,
  reason: "journal-missing" as const,
}));

const getManagedPluginCohortStatus = vi.fn(async () => ({
  version: 1 as const,
  consistency: "uncertain" as const,
  reason: "incomplete" as const,
}));

const getManagedPluginCohortV2Status = vi.fn(async () => ({
  version: 2 as const,
  consistency: "uncertain" as const,
  reason: "incomplete" as const,
}));
const features: {
  managedPluginStatus?: boolean;
  managedPluginCohortStatus?: boolean;
  managedPluginCohortV2?: boolean;
  managedPluginPromotions?: boolean;
  pluginManagement?: boolean;
  pluginLogs?: boolean;
  pluginGitManagement?: boolean;
  pluginSourceInstallation?: boolean;
  pluginSourceUpdates?: boolean;
} = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins,
    recoverPlugin,
    getManagedPluginStatus,
    getManagedPluginCohortStatus,
    getManagedPluginCohortV2Status,
    getPluginLogs,
    installDirectoryPlugin,
    installPluginSource,
    previewPluginUpdates,
    close,
  })),
}));

import { render } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import {
  createPluginCommand,
  runPluginInstallCommand,
  runPluginUpdateCommand,
  runPluginListCommand,
  runPluginLogsCommand,
  runPluginRecoverCommand,
  runManagedPluginStatusCommand,
  runManagedPluginCohortStatusCommand,
  runManagedPluginCohortV2StatusCommand,
} from "./index.js";

describe("plugin management commands", () => {
  it.each(["list", "logs", "managed-status", "cohort-status", "cohort-v2-status"])(
    "does not persist a CLI client ID for plugin %s observation",
    async (operation) => {
      features.pluginManagement = true;
      features.pluginLogs = true;
      features.managedPluginStatus = true;
      features.managedPluginCohortStatus = true;
      features.managedPluginCohortV2 = true;
      const options = { daemonTarget };
      switch (operation) {
        case "list":
          await runPluginListCommand(undefined, options, {} as never);
          break;
        case "logs":
          await runPluginLogsCommand("managed", options, {} as never);
          break;
        case "managed-status":
          await runManagedPluginStatusCommand("managed", options, {} as never);
          break;
        case "cohort-status":
          await runManagedPluginCohortStatusCommand(options, {} as never);
          break;
        case "cohort-v2-status":
          await runManagedPluginCohortV2StatusCommand(options, {} as never);
          break;
      }
      expect(connectToDaemon).toHaveBeenCalledExactlyOnceWith({
        target: daemonTarget,
        persistClientId: false,
      });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps ordinary persistent client initialization for plugin mutations", async () => {
    features.pluginSourceInstallation = true;
    features.pluginSourceUpdates = true;
    features.managedPluginPromotions = true;
    await runPluginInstallCommand("git:owner/plugin", { daemonTarget }, {} as never);
    await runPluginUpdateCommand("managed", { daemonTarget, check: true }, {} as never);
    await runPluginRecoverCommand(
      "managed",
      { daemonTarget, expectedPath: "/snapshots/old", expectedGeneration: "4" },
      {} as never,
    );
    expect(connectToDaemon).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(connectToDaemon).mock.calls)
      expect(call).toEqual([{ target: daemonTarget }]);
  });

  it("gates managed status once and preserves uncertain native evidence", async () => {
    await expect(
      runManagedPluginStatusCommand("managed", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(getManagedPluginStatus).not.toHaveBeenCalled();
    features.managedPluginStatus = true;
    const result = await runManagedPluginStatusCommand("managed", { daemonTarget }, {} as never);
    expect(result.data).toMatchObject({ consistency: "uncertain", reason: "journal-missing" });
    expect(getManagedPluginStatus).toHaveBeenCalledWith("managed");
  });
  it("gates complete cohort transport and preserves native uncertainty", async () => {
    await expect(
      runManagedPluginCohortStatusCommand({ daemonTarget }, {} as never),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(getManagedPluginCohortStatus).not.toHaveBeenCalled();
    features.managedPluginCohortStatus = true;
    const result = await runManagedPluginCohortStatusCommand({ daemonTarget }, {} as never);
    expect(result.data).toEqual({ version: 1, consistency: "uncertain", reason: "incomplete" });
  });
  it("requires the distinct V2 transport feature without falling back to V1", async () => {
    features.managedPluginCohortStatus = true;
    await expect(
      runManagedPluginCohortV2StatusCommand({ daemonTarget }, {} as never),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(getManagedPluginCohortV2Status).not.toHaveBeenCalled();
    expect(getManagedPluginCohortStatus).not.toHaveBeenCalled();
    features.managedPluginCohortV2 = true;
    const result = await runManagedPluginCohortV2StatusCommand({ daemonTarget }, {} as never);
    expect(result.data).toEqual({ version: 2, consistency: "uncertain", reason: "incomplete" });
  });
  beforeEach(() => {
    features.managedPluginPromotions = false;
    features.managedPluginStatus = false;
    features.managedPluginCohortStatus = false;
    features.managedPluginCohortV2 = false;
    features.pluginManagement = false;
    features.pluginLogs = false;
    features.pluginGitManagement = false;
    features.pluginSourceInstallation = false;
    features.pluginSourceUpdates = false;
    vi.clearAllMocks();
  });

  it("requires host support before attempting a management RPC", async () => {
    await expect(
      runPluginListCommand(undefined, { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use plugin management.",
    });
    expect(listPlugins).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps status as a hidden alias for the network-free plugin list", async () => {
    features.pluginManagement = true;
    const command = createPluginCommand();

    await command.parseAsync(["status", "--host", daemonTarget.host], { from: "user" });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(connectToDaemon).toHaveBeenCalledExactlyOnceWith({
      target: daemonTarget,
      persistClientId: false,
    });
    const help = command.helpInformation();
    expect(help).not.toMatch(/^\s+status(?:\s|$)/m);
    expect(help).toMatch(/^\s+cohort-status(?:\s|$)/m);
    expect(help).toMatch(/^\s+cohort-v2-status(?:\s|$)/m);
  });

  it("lists runtime state and the installed commit without an upstream commit", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand(undefined, { daemonTarget }, {} as never);
    const output = render(result, { noColor: true });

    expect(output).toContain("SOURCE");
    expect(output).toContain("REVISION");
    expect(output).not.toContain("LATEST");
    expect(output).toContain("1557a34c91e2");
    expect(output).toContain("This plugin was made for an older version of Paseo");
  });

  it("filters the shared ls and status command by plugin ID", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand("legacy-plugin", { daemonTarget }, {} as never);

    expect(result.data.map((plugin) => plugin.id)).toEqual(["legacy-plugin"]);
  });

  it("requires plugin log support before attempting the RPC", async () => {
    await expect(
      runPluginLogsCommand("example", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to view plugin logs.",
    });
    expect(getPluginLogs).not.toHaveBeenCalled();
  });

  it("returns readable and JSON plugin log output", async () => {
    features.pluginLogs = true;
    const result = await runPluginLogsCommand("example", { daemonTarget }, {} as never);

    expect(getPluginLogs).toHaveBeenCalledWith("example");
    expect(render(result, { noColor: true })).toContain("ready");
    expect(JSON.parse(render(result, { format: "json" }))).toEqual([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
    ]);
  });

  it("makes trust explicit at the plugin add entry point", () => {
    const command = createPluginCommand();
    expect(
      command.commands.find((subcommand) => subcommand.name() === "install")?.description(),
    ).toContain("Trust and install");
    expect(command.helpInformation()).toContain("trusted, unsandboxed plugins");
  });

  it("prints the trust acknowledgement before installing", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/trusted-plugin"], { from: "user" });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("preparation commands run unsandboxed on the daemon host"),
    );
    expect(installPluginSource).toHaveBeenCalledWith({ source: "/plugins/trusted-plugin" });
    stderr.mockRestore();
  });

  it("requires source support for directory installs without using the legacy RPC", async () => {
    features.pluginManagement = true;
    features.pluginGitManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runPluginInstallCommand("/plugins/trusted-plugin", { daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to install plugin sources.",
    });
    expect(installPluginSource).not.toHaveBeenCalled();
    expect(installDirectoryPlugin).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it.each([undefined, false, true])(
    "installs with source support and Git support=%s",
    async (gitSupport) => {
      features.pluginSourceInstallation = true;
      features.pluginGitManagement = gitSupport;
      await runPluginInstallCommand("npm:@acme/review@^1.0.0", { daemonTarget }, {} as never);
      expect(installPluginSource).toHaveBeenCalledWith({ source: "npm:@acme/review@^1.0.0" });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    "rejects installs before an RPC when source support=%s despite Git support",
    async (sourceSupport) => {
      features.pluginGitManagement = true;
      features.pluginSourceInstallation = sourceSupport;
      await expect(
        runPluginInstallCommand("owner/review", { daemonTarget }, {} as never),
      ).rejects.toMatchObject({
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to install plugin sources.",
      });
      expect(installPluginSource).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false, true])(
    "reviews updates with source install support=%s",
    async (sourceSupport) => {
      features.pluginSourceUpdates = true;
      features.pluginSourceInstallation = sourceSupport;
      await runPluginUpdateCommand("review", { daemonTarget }, {} as never);
      expect(previewPluginUpdates).toHaveBeenCalledWith({ pluginId: "review", target: undefined });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, false])(
    "rejects reviewed updates when support=%s despite legacy Git support",
    async (gitSupport) => {
      features.pluginSourceInstallation = true;
      features.pluginGitManagement = true;
      features.pluginSourceUpdates = gitSupport;
      await expect(
        runPluginUpdateCommand("review", { daemonTarget }, {} as never),
      ).rejects.toMatchObject({
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to review plugin updates.",
      });
      expect(previewPluginUpdates).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("folds the legacy --path option into the plugin source reference", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "git:owner/monorepo", "--path", "plugins/review"], {
      from: "user",
    });

    expect(installPluginSource).toHaveBeenCalledWith({
      source: "git:owner/monorepo:plugins/review",
    });
    stderr.mockRestore();
  });

  it("keeps an absolute monorepo path as one plugin source reference", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/monorepo:plugins/review"], { from: "user" });

    expect(installPluginSource).toHaveBeenCalledWith({
      source: "/plugins/monorepo:plugins/review",
    });
    stderr.mockRestore();
  });
});

import { reviewPluginUpdates, type UpdateInteraction } from "./update.js";
import type {
  PluginUpdatePreview,
  PluginUpdateProposal,
  PluginUpdateResult,
} from "@getpaseo/protocol/messages";
function reviewFixture(answer = true, outcome: "update" | "installed-newer" = "update") {
  const proposal: PluginUpdateProposal = {
    id: "review",
    expected: {
      identity: { kind: "npm", packageName: "review", pluginPath: "." },
      installationRoot: "/owned/one",
      revision: "1.0.0",
    },
    target: {
      kind: "npm",
      version: "1.1.0",
      resolved: "https://registry.npmjs.org/review.tgz",
      integrity: "sha512-test",
    },
  };
  const preview: PluginUpdatePreview = {
    id: "review",
    outcome,
    links: ["https://npmjs.com/package/review/v/1.1.0"],
    current: { identity: proposal.expected.identity, currentRevision: "1.0.0" },
    target: proposal.target,
    ...(outcome === "update" ? { proposal } : {}),
  };
  const applied: PluginUpdateProposal[][] = [];
  const questions: string[] = [];
  const output: string[] = [];
  const client = {
    previewPluginUpdates: async () => [preview],
    applyPluginUpdates: async (
      proposals: PluginUpdateProposal[],
    ): Promise<PluginUpdateResult[]> => {
      applied.push(proposals);
      return [{ id: "review", outcome: "updated" }];
    },
  };
  const interaction: UpdateInteraction = {
    interactive: true,
    structured: false,
    write: (text) => {
      output.push(text);
    },
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
  };
  return { client, interaction, proposal, applied, questions, output };
}
describe("reviewed plugin update workflow", () => {
  it("prints target and links, then declines without applying", async () => {
    const f = reviewFixture(false);
    expect(await reviewPluginUpdates(f.client, { pluginId: "review" }, f.interaction)).toEqual([
      { id: "review", outcome: "declined" },
    ]);
    expect(f.output.join("")).toContain("1.0.0 → 1.1.0");
    expect(f.output.join("")).toContain("Review: https://");
    expect(f.questions).toEqual(["Update review? [y/N] "]);
    expect(f.applied).toEqual([]);
  });
  it("applies exactly the displayed proposal after approval", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(f.client, { pluginId: "review" }, f.interaction);
    expect(f.applied).toEqual([[f.proposal]]);
  });
  it.each([{ yes: true }, { version: "stable" }, { ref: "v1" }])(
    "skips questions for %j",
    async (options) => {
      const f = reviewFixture();
      await reviewPluginUpdates(f.client, { pluginId: "review", ...options }, f.interaction);
      expect(f.questions).toEqual([]);
      expect(f.applied).toEqual([[f.proposal]]);
    },
  );
  it("check takes precedence over yes and explicit targets", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(
      f.client,
      { pluginId: "review", check: true, yes: true, version: "1.1.0" },
      f.interaction,
    );
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });
  it("yes never applies an ordinary downgrade", async () => {
    const f = reviewFixture(true, "installed-newer");
    await reviewPluginUpdates(f.client, { all: true, yes: true }, f.interaction);
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });
  it.each([{ interactive: false }, { structured: true }])(
    "requires explicit approval for %j",
    async (flags) => {
      const f = reviewFixture();
      await expect(
        reviewPluginUpdates(f.client, { pluginId: "review" }, { ...f.interaction, ...flags }),
      ).rejects.toThrow("Confirmation required");
      expect(f.applied).toEqual([]);
    },
  );
});

it("sends recovery source/generation CAS through the supported typed client after feature gating", async () => {
  features.managedPluginPromotions = false;
  const options = { daemonTarget, expectedPath: "/snapshots/candidate", expectedGeneration: "4" };
  await expect(
    runPluginRecoverCommand("managed", options, createPluginCommand()),
  ).rejects.toMatchObject({
    code: "DAEMON_UPDATE_REQUIRED",
  });
  expect(recoverPlugin).not.toHaveBeenCalled();
  features.managedPluginPromotions = true;
  const result = await runPluginRecoverCommand("managed", options, createPluginCommand());
  expect(recoverPlugin).toHaveBeenCalledWith({
    pluginId: "managed",
    expectedPath: "/snapshots/candidate",
    expectedGeneration: 4,
  });
  expect(result.data.path).toBe("/snapshots/old");
});
