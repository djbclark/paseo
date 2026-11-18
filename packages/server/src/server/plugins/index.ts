import {
  runQualifiedPluginInitialization,
  type QualifiedPluginInitialization,
} from "./qualified-initialization.js";
import { assertHeldPluginOperation } from "../maintenance-reservation.js";
import {
  assertHeldPluginOperationResult,
  type HeldPluginOperationClaim,
  type HeldPluginOperationScope,
  type HeldPluginOperationResult,
  type KnownFailedHeldObservation,
} from "../maintenance-operation.js";
import { assertPluginHeldOperation, type PluginHeldOperation } from "./held-operation.js";
import {
  compileQualifiedDirectoryPlugin,
  readSettledQualifiedCompilerFailure,
  type SettledQualifiedCompilerFailure,
} from "./compiler.js";
import {
  isQualifiedDaemonOwner,
  getQualifiedDaemonObservation,
} from "../execution/qualified-host.js";
import type { QualifiedDaemonOwner } from "../execution/daemon-types.js";
import {
  getQualifiedCompilerObservations,
  getQualifiedCompilerObservationEpoch,
} from "./compiler.js";
import { boundedStatusRead, observeManagedStatus } from "./managed-status.js";
import {
  samePluginMaintenanceIdentity,
  type NativePluginAdmission,
  type PluginMaintenanceIdentity,
  type PluginMaintenancePort,
} from "./maintenance.js";
import { isDeepStrictEqual } from "node:util";
import {
  ManagedPluginActivationPolicy,
  type ActivationOperation,
  type ManagedPluginActivationState,
} from "./activation-policy.js";
import type { PluginAgentToolsRuntime } from "./agent-tools.js";
import type { PluginLifecycle } from "./lifecycle/index.js";
import path from "node:path";
import { stat, rm } from "node:fs/promises";
import type pino from "pino";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import {
  PluginIdSchema,
  type ManagedPluginStatus,
  type ManagedPluginCohortStatus,
  type ManagedPluginCohortV2Status,
  type PluginLogEntry,
  type PluginListItem,
  type PluginSource,
  type PluginSourceStatusItem,
  type PluginSourceUpdateItem,
  type PluginUpdateSelection,
  type PluginUpdateProposal,
  type PluginUpdatePreview,
  type PluginUpdateResult,
} from "@getpaseo/protocol/messages";
import { parsePluginSourceReference } from "@getpaseo/protocol/plugin-source-reference";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { type ManagedPluginCandidate, ManagedPluginSources } from "./managed-source.js";
import { readPluginManifest } from "./manifest.js";
import { expandTilde } from "../../utils/path.js";
import { runPluginBuild } from "./preparation.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginRuntimeSubscription } from "./runtime-subscription.js";
import { BuiltinPluginLoader, type BuiltinPlugin } from "./builtin/index.js";
import type { PluginProviderMetadata } from "./plugin-process-protocol.js";
import { readPluginProviderIcon } from "./provider-icon.js";
import {
  type AgentUsageLookup,
  type ListUsageReportsOptions,
  UsageSourceRegistry,
} from "./usage-sources/index.js";
import type { PluginUsageSourceMetadata } from "./plugin-process-protocol.js";

type HeldPluginDriverResult = HeldPluginOperationResult | KnownFailedHeldObservation;

interface DirectoryReplacementInput {
  pluginId: string;
  path: string;
  expectedPath: string;
  expectedGeneration: number;
}
interface PluginRecoveryInput {
  pluginId: string;
  expectedPath: string;
  expectedGeneration: number;
}
interface ReplacementActivation {
  pluginId: string;
  source: PluginSource;
  candidate: string;
  policy: ManagedPluginActivationPolicy;
}
type RetainedPluginBaseline = NonNullable<ManagedPluginActivationState["baseline"]>;
interface RetainedBaselineValidation {
  pluginId: string;
  baseline: RetainedPluginBaseline;
  policy: ManagedPluginActivationPolicy;
}
interface RecoveryIdentityInspection {
  pluginId: string;
  current: PluginSource;
  state: ManagedPluginActivationState;
  baseline: RetainedPluginBaseline;
  loaded: PluginListItem["loaded"];
  policy: ManagedPluginActivationPolicy;
}
interface NativeUpdateRecovery extends NativeUpdateActivation {
  wasRunning: boolean;
  failure: unknown;
}
interface NativeUpdateActivation {
  pluginId: string;
  source: PluginSource;
  candidate: ManagedPluginCandidate;
  managedSources: ManagedPluginSources;
}

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS);

interface PluginRuntimePort {
  getObservationEpoch?: PluginRuntime["getObservationEpoch"];
  observeQualifiedExecutions?: PluginRuntime["observeQualifiedExecutions"];
  observeQualifiedDirectoryExecutions?: PluginRuntime["observeQualifiedDirectoryExecutions"];
  observeBuiltinCohort?: PluginRuntime["observeBuiltinCohort"];
  tryValidateHeldActivation?: PluginRuntime["tryValidateHeldActivation"];
  readonly maintenance?: PluginMaintenancePort;
  subscribeSessionOpenChanges?: PluginRuntime["subscribeSessionOpenChanges"];
  isToolPluginAvailable?: PluginRuntime["isToolPluginAvailable"];
  callTool?: PluginRuntime["callTool"];
  detachTools?: PluginRuntime["detachTools"];
  emit?: PluginLifecycle["emit"];
  drainEvents?: PluginRuntime["drainEvents"];
  before?: PluginLifecycle["before"];
  wait?: PluginLifecycle["wait"];
  validateActivation?: PluginRuntime["validateActivation"];
  getLoadedReceipt?: PluginRuntime["getLoadedReceipt"];
  catalog: PluginRuntime["catalog"];
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  startSubscription: PluginRuntime["startSubscription"];
  getLogs(pluginId: string): PluginLogEntry[];
  clearLogs(pluginId: string): void;
  getProviderRegistrations?(pluginId: string): readonly PluginProviderMetadata[];
  getUsageSourceRegistrations(pluginId: string): readonly PluginUsageSourceMetadata[];
  fetchUsage: PluginRuntime["fetchUsage"];
  discoverUsage: PluginRuntime["discoverUsage"];
  connectProvider: PluginRuntime["connectProvider"];
  getProviderCatalogCacheKey?: PluginRuntime["getProviderCatalogCacheKey"];
  getProviderStatus?: PluginRuntime["getProviderStatus"];
  validatePlugin?(path: string): Promise<void>;
  startPlugin(
    pluginId: string,
    path: string,
    canPublish: () => boolean,
    operation?: ActivationOperation,
    held?: PluginHeldOperation,
    initialization?: QualifiedPluginInitialization,
  ): Promise<void>;
  startBuiltinPlugin?(
    plugin: BuiltinPlugin,
    initialization?: QualifiedPluginInitialization,
  ): Promise<void>;
  stopPluginById(pluginId: string, held?: PluginHeldOperation): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (pluginId: string, error?: string) => void): () => void;
  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void;
}

interface PluginServiceDependencies {
  qualifiedDaemonOwner?: QualifiedDaemonOwner;
  serverId?: string;
  nativeMaintenance?: NativePluginAdmission;
  activationPolicy?: ManagedPluginActivationPolicy;
  usageAgents?: AgentUsageLookup;
  settingsDirectory?: string;
  runtime?: PluginRuntimePort;
  managedSources?: ManagedPluginSources;
  builtinPlugins?: BuiltinPluginLoader;
}

function resolvePluginStatus(input: {
  enabled: boolean;
  globallyEnabled: boolean;
  running: boolean;
}): PluginListItem["status"] {
  if (!input.enabled || !input.globallyEnabled) return "disabled";
  return input.running ? "running" : "failed";
}

export class PluginService {
  private maintenanceIdentity: PluginMaintenanceIdentity | null = null;
  private maintenanceUncertain = false;
  readonly maintenance: PluginMaintenancePort = {
    supportsV1: () => this.supportsQualifiedMaintenance(),
    begin: (identity) => {
      if (
        this.maintenanceIdentity &&
        !samePluginMaintenanceIdentity(this.maintenanceIdentity, identity)
      ) {
        this.maintenanceUncertain = true;
        return Promise.resolve("unknown");
      }
      this.maintenanceIdentity = { ...identity };
      return this.beginQualifiedMaintenance(identity);
    },
    end: async (identity) => {
      if (
        !this.maintenanceIdentity ||
        !samePluginMaintenanceIdentity(this.maintenanceIdentity, identity) ||
        this.maintenanceUncertain
      )
        throw new Error("Plugin maintenance release identity mismatch");
      if (!this.supportsQualifiedMaintenance() || !this.runtime.maintenance)
        throw new Error("Plugin executing closure is not qualified for maintenance release");
      await this.runtime.maintenance.end(identity);
      if (!this.supportsQualifiedMaintenance())
        throw new Error("Plugin maintenance release changed");
      this.maintenanceIdentity = null;
    },
  };
  private async beginQualifiedMaintenance(
    identity: PluginMaintenanceIdentity,
  ): Promise<"held" | "known-busy" | "unknown"> {
    const result = await (this.runtime.maintenance?.begin(identity) ??
      Promise.resolve("unknown" as const));
    if (result === "unknown") return result;
    try {
      await this.dependencies.activationPolicy?.observeEnrollment();
      if (!this.runtime.observeQualifiedExecutions) return "unknown";
      await this.runtime.observeQualifiedExecutions();
      return result;
    } catch {
      return "unknown";
    }
  }

  private supportsQualifiedMaintenance(): boolean {
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (!owner || !isQualifiedDaemonOwner(owner) || this.maintenanceUncertain || this.starting)
      return false;
    const loaded = new Set(this.runtime.catalog().map((plugin) => plugin.id));
    for (const id of this.builtinPluginIds) if (!loaded.has(id)) return false;
    if (this.configStore.get().pluginsEnabled === true)
      for (const [id, source] of Object.entries(this.configStore.get().plugins ?? {}))
        if (source.enabled !== false && !loaded.has(id)) return false;
    return this.runtime.maintenance?.supportsV1() === true;
  }

  private requireLifecycleAdmission(): void {
    if (this.maintenanceIdentity || this.maintenanceUncertain)
      throw new Error("Plugin maintenance admission is closed");
  }

  private readonly runtime: PluginRuntimePort;
  private readonly managedSources: ManagedPluginSources | null;
  private readonly builtinPluginIds: ReadonlySet<string>;
  private readonly builtinPlugins: BuiltinPluginLoader;
  private readonly logger: pino.Logger;
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<(pluginId: string) => void>();
  private readonly providers = new Map<string, ProviderRegistration>();
  private readonly usageSources: UsageSourceRegistry;
  private readonly usageSourceIdsByPlugin = new Map<string, string[]>();
  private readonly providerIdsByPlugin = new Map<string, readonly string[]>();
  private readonly providerListeners = new Set<() => void>();
  private lifecycle = Promise.resolve();
  private globalStartsBlocked = true;
  private readonly pendingOperations = new Map<
    string,
    { kind: "disable" | "remove"; completion: Promise<void> }
  >();
  private started = false;
  private starting = false;
  private readonly settingsListeners = new Set<(pluginId: string, settingsId: string) => void>();

  constructor(
    logger: pino.Logger,
    private readonly configStore: DaemonConfigStore,
    private readonly daemonVersion: string,
    private readonly dependencies: PluginServiceDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugin-service" });
    this.usageSources = new UsageSourceRegistry(
      Date.now,
      300_000,
      this.logger,
      dependencies.usageAgents,
    );
    this.runtime =
      dependencies.runtime ??
      new PluginRuntime(logger, daemonVersion, {
        settingsDirectory: dependencies.settingsDirectory,
        activationPolicy: dependencies.activationPolicy,
        nativeMaintenance: dependencies.nativeMaintenance,
        qualifiedDaemonOwner: dependencies.qualifiedDaemonOwner,
        onSettingsChanged: (pluginId, settingsId) => {
          for (const listener of this.settingsListeners) listener(pluginId, settingsId);
        },
      });
    this.managedSources = dependencies.managedSources ?? null;
    this.builtinPlugins = dependencies.builtinPlugins ?? new BuiltinPluginLoader(undefined, []);
    this.builtinPluginIds = this.builtinPlugins.ids;
    if (
      dependencies.qualifiedDaemonOwner &&
      isQualifiedDaemonOwner(dependencies.qualifiedDaemonOwner)
    ) {
      dependencies.activationPolicy?.bindQualifiedAuthority(dependencies.qualifiedDaemonOwner);
      qualifiedServices.set(dependencies.qualifiedDaemonOwner, this);
    }
    this.runtime.subscribe((pluginId, error) => {
      this.removeProviderRegistrations(pluginId);
      this.removeUsageSources(pluginId);
      if (error) this.errors.set(pluginId, error);
      this.notify(pluginId);
    });
  }

  readonly emit: PluginLifecycle["emit"] = (name, event) => {
    this.runtime.emit?.(name, event);
  };

  subscribeSessionOpenChanges(listener: () => void): () => void {
    return this.runtime.subscribeSessionOpenChanges?.(listener) ?? (() => {});
  }

  readonly isToolPluginAvailable: PluginAgentToolsRuntime["isToolPluginAvailable"] = (
    pluginId,
    pluginInstanceId,
  ) => {
    return this.runtime.isToolPluginAvailable?.(pluginId, pluginInstanceId) ?? false;
  };

  readonly detachTools: PluginAgentToolsRuntime["detachTools"] = (agentId) => {
    this.runtime.detachTools?.(agentId);
  };

  readonly callTool: PluginAgentToolsRuntime["callTool"] = async (
    pluginId,
    pluginInstanceId,
    agent,
    name,
    input,
    signal,
  ) => {
    if (!this.isToolPluginAvailable(pluginId, pluginInstanceId) || !this.runtime.callTool)
      return { isError: true, text: `Plugin is not available: ${pluginId}` };
    return this.runtime.callTool(pluginId, pluginInstanceId, agent, name, input, signal);
  };

  readonly wait: PluginLifecycle["wait"] = async (name, payload) => {
    await this.runtime.wait?.(name, payload);
  };

  async drainEvents(): Promise<void> {
    await this.runtime.drainEvents?.();
  }

  readonly before: PluginLifecycle["before"] = async (name, request) => {
    if (this.runtime.before) {
      return this.runtime.before(name, request);
    }
    return request;
  };

  subscribeSettings(listener: (pluginId: string, settingsId: string) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  subscribe(listener: (pluginId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bindPaseoSessionHost(sessionHost: Parameters<PluginRuntime["bindPaseoSessionHost"]>[0]): void {
    this.runtime.bindPaseoSessionHost(sessionHost);
  }

  getProviderRegistrations(): readonly ProviderRegistration[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listUsageReports(options?: ListUsageReportsOptions) {
    return this.usageSources.listReports(options);
  }

  listLegacyUsage() {
    return this.usageSources.listLegacyUsage();
  }

  subscribeProviderRegistrations(listener: () => void): () => void {
    this.providerListeners.add(listener);
    return () => this.providerListeners.delete(listener);
  }

  async start(): Promise<void> {
    // An unsupported restored hold keeps plugin code uninitialized. No early END for startup.
    if (this.maintenanceUncertain) return;
    if (
      this.maintenanceIdentity &&
      (!this.dependencies.qualifiedDaemonOwner ||
        !isQualifiedDaemonOwner(this.dependencies.qualifiedDaemonOwner))
    )
      return;
    if (this.started) return;
    this.starting = true;
    try {
      this.started = true;
      const config = this.configStore.get();
      this.globalStartsBlocked = config.pluginsEnabled !== true;
      await this.builtinPlugins.load(async (plugin) => {
        try {
          await this.startBuiltinDuringBootstrap(plugin);
          await this.publishProviderRegistrations(plugin.id, plugin.directory);
          this.publishUsageSources(plugin.id);
        } catch (error) {
          this.logger.error({ err: error, pluginId: plugin.id }, "Failed to start built-in plugin");
        }
      });
      if (
        config.pluginsEnabled === true &&
        this.dependencies.qualifiedDaemonOwner &&
        isQualifiedDaemonOwner(this.dependencies.qualifiedDaemonOwner)
      ) {
        for (const [pluginId, source] of Object.entries(config.plugins ?? {})) {
          if (source.enabled === false) continue;
          await this.startConfiguredDuringBootstrap(pluginId);
          this.notify(pluginId);
        }
      } else if (config.pluginsEnabled === true) {
        let earlierPublished: Promise<unknown> = Promise.resolve();
        await Promise.all(
          Object.entries(config.plugins ?? {})
            .filter(([, source]) => source.enabled !== false)
            .map(async ([pluginId]) => {
              const publishTurn = earlierPublished;
              const starting = this.startConfiguredDuringBootstrap(pluginId, publishTurn);
              earlierPublished = Promise.all([publishTurn, starting]);
              await starting;
              this.notify(pluginId);
            }),
        );
      }
      this.configStore.onFieldChange("pluginsEnabled", (value) => {
        this.handleGlobalSwitch(value === true);
      });
    } finally {
      this.starting = false;
    }
  }

  private qualifiedEpoch = 0;
  private qualifiedConfigIdentity: object | undefined;
  private qualifiedMutations = 0;
  getQualifiedObservationEpoch(owner: QualifiedDaemonOwner): number | null {
    if (owner !== this.dependencies.qualifiedDaemonOwner || !isQualifiedDaemonOwner(owner))
      return null;
    const config = this.configStore.get();
    if (this.qualifiedConfigIdentity !== config) {
      this.qualifiedConfigIdentity = config;
      this.qualifiedEpoch++;
    }
    const runtime = this.runtime.getObservationEpoch?.();
    const compiler = getQualifiedCompilerObservationEpoch(owner);
    if (runtime === undefined || compiler === null) return null;
    return (
      this.qualifiedEpoch +
      runtime +
      compiler +
      (this.dependencies.activationPolicy?.getObservationEpoch() ?? 0)
    );
  }

  getManagedPluginCohortStatus(): Promise<ManagedPluginCohortStatus> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const uncertain = (reason: "busy" | "incomplete"): ManagedPluginCohortStatus => ({
      version: 1,
      consistency: "uncertain",
      reason,
    });
    const turn = this.lifecycle
      .then(() => (expired ? uncertain("busy") : this.captureQualifiedCohort()))
      .catch(() => uncertain("incomplete"));
    this.lifecycle = turn.then(
      () => undefined,
      () => undefined,
    );
    const deadline = new Promise<ManagedPluginCohortStatus>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve(uncertain("busy"));
      }, 1000);
    });
    return Promise.race([turn, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async captureQualifiedCohort(): Promise<ManagedPluginCohortStatus> {
    const uncertain = (
      reason: Extract<ManagedPluginCohortStatus, { consistency: "uncertain" }>["reason"],
    ): ManagedPluginCohortStatus => ({ version: 1, consistency: "uncertain", reason });
    const owner = this.dependencies.qualifiedDaemonOwner;
    const serverId = this.dependencies.serverId;
    const policy = this.dependencies.activationPolicy;
    if (!owner || !isQualifiedDaemonOwner(owner) || !serverId || !policy?.configured)
      return uncertain("authority-unavailable");
    if (this.starting || this.qualifiedMutations || this.pendingOperations.size)
      return uncertain("busy");
    if (!this.runtime.observeQualifiedExecutions) return uncertain("unqualified-host");
    if (this.builtinPluginIds.size) return uncertain("incomplete");
    try {
      await owner.refresh();
      const beforeEpoch = this.getQualifiedObservationEpoch(owner);
      if (beforeEpoch === null) return uncertain("incomplete");
      const config = this.configStore.get();
      const enrollment = await policy.observeEnrollment();
      const ids = [
        ...new Set([
          ...Object.keys(config.plugins ?? {}),
          ...this.builtinPluginIds,
          ...this.runtime.catalog().map((item) => item.id),
          ...enrollment.ids,
        ]),
      ].sort();
      const executions = await this.runtime.observeQualifiedExecutions();
      const { entries, journals } = await captureCohortEntries({
        ids,
        policy,
        enrollmentIds: enrollment.ids,
        config,
        builtinIds: this.builtinPluginIds,
        executions,
        loaded: (id) => this.runtime.getLoadedReceipt?.(id) ?? null,
      });
      await recheckCohortJournals(policy, journals);
      const afterEnrollment = await policy.observeEnrollment();
      await owner.refresh();
      const enclosing = getQualifiedDaemonObservation(owner);
      if (
        config !== this.configStore.get() ||
        enrollment.identity !== afterEnrollment.identity ||
        beforeEpoch !== this.getQualifiedObservationEpoch(owner) ||
        this.starting ||
        this.qualifiedMutations ||
        this.pendingOperations.size
      )
        return uncertain("changed");
      return structuredClone({
        version: 1,
        consistency: "coherent",
        observationEpoch: beforeEpoch,
        enclosing: {
          serverId,
          incarnation: enclosing.incarnation,
          distributionBuildId: enclosing.distributionBuildId,
          closure: { ...enclosing.closure },
        },
        entries,
      });
    } catch {
      return uncertain("incomplete");
    }
  }

  getManagedPluginCohortV2Status(): Promise<ManagedPluginCohortV2Status> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const uncertain = (reason: "busy" | "incomplete"): ManagedPluginCohortV2Status => ({
      version: 2,
      consistency: "uncertain",
      reason,
    });
    const turn = this.lifecycle
      .then(() => (expired ? uncertain("busy") : this.captureQualifiedCohortV2()))
      .catch(() => uncertain("incomplete"));
    this.lifecycle = turn.then(
      () => undefined,
      () => undefined,
    );
    const deadline = new Promise<ManagedPluginCohortV2Status>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve(uncertain("busy"));
      }, 1000);
    });
    return Promise.race([turn, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private hasPendingQualifiedMutation(): boolean {
    return this.starting || this.qualifiedMutations > 0 || this.pendingOperations.size > 0;
  }

  private async captureQualifiedCohortV2(): Promise<ManagedPluginCohortV2Status> {
    const uncertain = (
      reason: Extract<ManagedPluginCohortV2Status, { consistency: "uncertain" }>["reason"],
    ): ManagedPluginCohortV2Status => ({
      version: 2,
      consistency: "uncertain",
      reason,
    });
    const owner = this.dependencies.qualifiedDaemonOwner;
    const serverId = this.dependencies.serverId;
    const policy = this.dependencies.activationPolicy;
    if (!owner || !isQualifiedDaemonOwner(owner) || !serverId || !policy?.configured)
      return uncertain("authority-unavailable");
    if (this.hasPendingQualifiedMutation()) return uncertain("busy");
    const observeDirectories = this.runtime.observeQualifiedDirectoryExecutions?.bind(this.runtime);
    const observeBuiltins = this.runtime.observeBuiltinCohort?.bind(this.runtime);
    if (!observeDirectories || !observeBuiltins) return uncertain("unqualified-host");
    try {
      await owner.refresh();
      const beforeEpoch = this.getQualifiedObservationEpoch(owner);
      if (beforeEpoch === null) return uncertain("incomplete");
      const config = this.configStore.get();
      const enrollment = await policy.observeEnrollment();
      // A configured source cannot shadow a retained builtin identity.
      if (
        [...this.builtinPluginIds].some((id) => config.plugins?.[id] || enrollment.ids.includes(id))
      )
        return uncertain("incomplete");
      const ids = [
        ...new Set([
          ...Object.keys(config.plugins ?? {}),
          ...this.runtime.catalog().map((item) => item.id),
          ...enrollment.ids,
        ]),
      ]
        .filter((id) => !this.builtinPluginIds.has(id))
        .sort();
      const executions = await observeDirectories();
      const { entries: directories, journals } = await captureCohortEntries({
        ids,
        policy,
        enrollmentIds: enrollment.ids,
        config,
        builtinIds: new Set(),
        executions,
        loaded: (id) => this.runtime.getLoadedReceipt?.(id) ?? null,
      });
      const entries = assembleCohortV2Entries(
        directories,
        observeBuiltins(),
        this.builtinPluginIds,
        owner.root,
      );
      await recheckCohortJournals(policy, journals);
      const afterEnrollment = await policy.observeEnrollment();
      await owner.refresh();
      const enclosing = getQualifiedDaemonObservation(owner);
      if (
        config !== this.configStore.get() ||
        enrollment.identity !== afterEnrollment.identity ||
        beforeEpoch !== this.getQualifiedObservationEpoch(owner) ||
        this.hasPendingQualifiedMutation()
      )
        return uncertain("changed");
      return structuredClone({
        version: 2,
        consistency: "coherent",
        observationEpoch: beforeEpoch,
        enclosing: {
          serverId,
          incarnation: enclosing.incarnation,
          distributionBuildId: enclosing.distributionBuildId,
          closure: { ...enclosing.closure },
        },
        entries,
      });
    } catch {
      return uncertain("incomplete");
    }
  }

  getManagedPluginStatus(pluginId: string): Promise<ManagedPluginStatus> {
    PluginIdSchema.parse(pluginId);
    const { turn, result } = boundedStatusRead(pluginId, this.lifecycle, () =>
      observeManagedStatus(pluginId, this.dependencies.activationPolicy, () => {
        const config = this.configStore.get();
        return {
          configIdentity: config,
          registration: config.plugins?.[pluginId],
          loaded: this.runtime.getLoadedReceipt?.(pluginId),
          epoch: this.runtime.getObservationEpoch?.(),
          busy: this.starting || this.pendingOperations.has(pluginId),
        };
      }),
    );
    // Read turns serialize with mutations but require no normal-work admission while held.
    this.lifecycle = turn.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listPlugins(): Promise<PluginListItem[]> {
    const config = this.configStore.get();
    const running = new Set(this.runtime.catalog().map((plugin) => plugin.id));
    const plugins = await Promise.all(
      Object.entries(config.plugins ?? {}).map(async ([id, source]) => {
        const enabled = source.enabled !== false;
        const item: PluginListItem = {
          id,
          loaded: this.runtime.getLoadedReceipt?.(id),
          promotionState: await this.dependencies.activationPolicy?.status(id),
          path: source.path,
          enabled,
          status: resolvePluginStatus({
            enabled,
            globallyEnabled: config.pluginsEnabled === true,
            running: running.has(id),
          }),
        };
        const manifest = await readPluginManifest(path.resolve(source.path)).catch(() => null);
        if (manifest) {
          item.name = manifest.name;
          item.description = manifest.description;
          item.icon = manifest.icon;
          item.media = manifest.media;
        }
        item.installation = await this.managedSources
          ?.describe(id, source.path)
          .catch(() => undefined);
        if (!this.managedSources)
          item.installation = { identity: { kind: "directory", path: path.resolve(source.path) } };
        if (item.installation?.identity.kind === "git") {
          item.source = "git";
          item.remote = item.installation.identity.remote;
          item.commit = item.installation.currentRevision;
        }
        const error = this.errors.get(id);
        if (error && item.status === "failed") item.error = error;
        return item;
      }),
    );
    return plugins.sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    if (!this.builtinPluginIds.has(pluginId)) {
      this.requireSource(pluginId);
    }
    return this.runtime.getLogs(pluginId);
  }

  catalog(): ReturnType<PluginRuntime["catalog"]> {
    return this.runtime.catalog();
  }

  async installDirectory(input: { path: string; id?: string }): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const directory = path.resolve(input.path);
      const manifest = await readPluginManifest(directory);
      assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
      const pluginId = PluginIdSchema.parse(input.id ?? manifest.id);
      if (this.builtinPluginIds.has(pluginId)) {
        throw new Error(`Plugin ID "${pluginId}" is reserved for a built-in plugin`);
      }
      if (this.configStore.get().plugins?.[pluginId]) {
        throw new Error(
          `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
        );
      }
      await this.dependencies.activationPolicy?.authorize(pluginId, directory);
      await this.patchSource(pluginId, { source: "directory", path: directory, enabled: true });
      if (this.canPublish(pluginId)) await this.startConfigured(pluginId);
      this.notify(pluginId);
      const installed = await this.requireItem(pluginId);
      if (installed.status === "failed") {
        throw new Error(installed.error ?? `Plugin failed to start: ${pluginId}`);
      }
      return installed;
    });
  }

  heldPluginOperation(
    claim: HeldPluginOperationClaim,
    scope: HeldPluginOperationScope,
  ): Promise<HeldPluginDriverResult> {
    assertHeldPluginOperation(scope, claim);
    const native = this.dependencies.nativeMaintenance;
    if (!native?.runHeldOperation)
      return Promise.reject(new Error("Held plugin admission unavailable"));
    const held = { claim, scope };
    const admitted = () =>
      native.runHeldOperation!(scope, claim, async () => {
        assertPluginHeldOperation(held, claim.pluginId, claim.path);
        if (
          !this.maintenanceIdentity ||
          !samePluginMaintenanceIdentity(this.maintenanceIdentity, claim)
        )
          throw new Error("Held plugin reservation identity mismatch");
        this.qualifiedEpoch++;
        this.qualifiedMutations++;
        let result: HeldPluginDriverResult;
        try {
          result = await this.performHeldPluginOperation(held);
        } finally {
          this.qualifiedMutations--;
          this.qualifiedEpoch++;
        }
        const record = knownFailedHeldResults.get(result);
        if (record) {
          assertHeldPluginOperation(scope, claim);
          record.epoch = this.getQualifiedObservationEpoch(record.owner);
          if (record.epoch === null) throw new Error("Known failure observation unavailable");
        }
        return result;
      });
    const turn = this.lifecycle.then(admitted, admitted);
    this.lifecycle = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async performHeldPluginOperation(
    held: PluginHeldOperation,
  ): Promise<HeldPluginDriverResult> {
    const { claim } = held;
    const policy = this.dependencies.activationPolicy;
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (
      !policy ||
      !owner ||
      !isQualifiedDaemonOwner(owner) ||
      !this.runtime.validateActivation ||
      !this.runtime.observeQualifiedExecutions
    )
      throw new Error("Qualified managed operation unavailable");
    await owner.refresh();
    const source = this.requireSource(claim.pluginId);
    const state = await policy.status(claim.pluginId);
    if (
      source.source !== "directory" ||
      source.path !== claim.expectedPath ||
      state.generation !== claim.expectedGeneration
    )
      throw new Error("Held plugin source/generation CAS mismatch");
    if (
      this.configStore.get().pluginsEnabled !== true ||
      this.pendingOperations.has(claim.pluginId)
    )
      throw new Error("Held plugin operation cancelled");
    if (claim.operation === "verify") return this.verifyHeldPlugin(held);
    if (claim.operation === "replace") return this.replaceHeldPlugin(held, source);
    return this.recoverHeldPlugin(held, source, state);
  }

  private async verifyHeldPlugin(held: PluginHeldOperation): Promise<HeldPluginDriverResult> {
    const { claim } = held;
    const loaded = this.runtime.getLoadedReceipt?.(claim.pluginId);
    if (
      claim.path !== claim.expectedPath ||
      !loaded?.snapshotRoot ||
      !loaded.snapshotSha256 ||
      loaded.sourcePath !== claim.path ||
      loaded.snapshotSha256 !== claim.snapshotSha256 ||
      loaded.serverBundleSha256 !== claim.serverBundleSha256
    )
      throw new Error("Held verification requires exact actual loaded identity");
    await this.runtime.observeQualifiedExecutions!();
    const owner = this.dependencies.qualifiedDaemonOwner!;
    const native = this.dependencies.nativeMaintenance!;
    const context = { owner, native, held, snapshotRoot: loaded.snapshotRoot };
    await compileQualifiedDirectoryPlugin(claim.path, this.daemonVersion, context);
    await compileQualifiedDirectoryPlugin(claim.path, this.daemonVersion, context);
    if (this.runtime.getLoadedReceipt?.(claim.pluginId) !== loaded)
      throw new Error("Loaded identity changed during verification");
    return this.finishHeldPluginOperation(held);
  }

  private async replaceHeldPlugin(
    held: PluginHeldOperation,
    source: PluginSource,
  ): Promise<HeldPluginDriverResult> {
    const { claim } = held;
    const policy = this.dependencies.activationPolicy!;
    if (source.enabled === false || claim.path === source.path)
      throw new Error("Held replacement requires enabled distinct source");
    const baseline = await this.requireManagedBaseline(claim.pluginId, source, policy);
    const validation = await this.validateHeldCandidate(held, "activate");
    await this.runtime.observeQualifiedExecutions!();
    await this.assertHeldCas(held, source.path);
    await policy.replacing(claim.pluginId, source.path, claim.path, { source, receipt: baseline });
    if (validation.attempt.outcome === "compiler_error") {
      await policy.hold(claim.pluginId);
      return this.certifyKnownCompilerFailure(held, validation.ticket, validation.attempt);
    }
    try {
      await this.stopHeldPlugin(held);
      await this.launchHeldPlugin(held, "activate");
      await this.assertHeldSource(held, source.path);
      await this.patchSource(claim.pluginId, { ...source, path: claim.path });
      await policy.committedReplacement(claim.pluginId);
      return await this.finishHeldPluginOperation(held);
    } catch (error) {
      await this.holdFailedPlugin(held);
      throw error;
    } finally {
      policy.releaseReplacement(claim.pluginId);
    }
  }

  private async recoverHeldPlugin(
    held: PluginHeldOperation,
    source: PluginSource,
    state: ManagedPluginActivationState,
  ): Promise<HeldPluginDriverResult> {
    const { claim } = held;
    const policy = this.dependencies.activationPolicy!;
    const baseline = state.baseline;
    if (
      !baseline ||
      baseline.source.source !== "directory" ||
      baseline.source.path !== claim.path ||
      baseline.receipt.sourcePath !== claim.path ||
      baseline.receipt.snapshotSha256 !== claim.snapshotSha256 ||
      baseline.receipt.serverBundleSha256 !== claim.serverBundleSha256
    )
      throw new Error("Held recovery requires exact retained baseline evidence");
    const loaded = this.runtime.getLoadedReceipt?.(claim.pluginId);
    await this.inspectRecoveryIdentity({
      pluginId: claim.pluginId,
      current: source,
      state,
      baseline,
      loaded,
      policy,
    });
    const validation = await this.validateHeldCandidate(held, "recover");
    await this.assertHeldCas(held, source.path);
    if (validation.attempt.outcome === "compiler_error") {
      await policy.hold(claim.pluginId);
      return this.certifyKnownCompilerFailure(held, validation.ticket, validation.attempt);
    }
    await policy.recovering(claim.pluginId, claim.expectedGeneration);
    try {
      await this.stopHeldPlugin(held);
      await this.launchHeldPlugin(held, "recover");
      await this.assertHeldSource(held, source.path);
      await this.patchSource(claim.pluginId, { ...baseline.source, enabled: true });
      await policy.committedReplacement(claim.pluginId);
      return await this.finishHeldPluginOperation(held);
    } catch (error) {
      await this.holdFailedPlugin(held);
      throw error;
    } finally {
      policy.releaseReplacement(claim.pluginId);
    }
  }

  private async validateHeldCandidate(held: PluginHeldOperation, operation: ActivationOperation) {
    const { claim } = held;
    if (!this.runtime.tryValidateHeldActivation)
      throw new Error("Actual held compiler unavailable");
    await this.checkRequirements(claim.path);
    const result = await this.runtime.tryValidateHeldActivation(
      claim.pluginId,
      claim.path,
      operation,
      held,
    );
    if (
      result.ticket.authorization.snapshotSha256 !== claim.snapshotSha256 ||
      result.ticket.authorization.serverBundleSha256 !== claim.serverBundleSha256
    )
      throw new Error("Held candidate differs from protected artifact");
    return result;
  }

  private async certifyKnownCompilerFailure(
    held: PluginHeldOperation,
    ticket: import("./activation-policy.js").ActivationTicket,
    failure: SettledQualifiedCompilerFailure,
  ): Promise<KnownFailedHeldObservation> {
    const owner = this.dependencies.qualifiedDaemonOwner!;
    const policy = this.dependencies.activationPolicy!;
    if (!readSettledQualifiedCompilerFailure(failure, owner, held))
      throw new Error("Missing actual compiler settlement");
    const config = this.configStore.get();
    const first = await policy.observeStatus(held.claim.pluginId);
    const baseline = first.state.baseline;
    if (!baseline || !baseline.receipt.snapshotSha256 || first.state.phase !== "held")
      throw new Error("Known failure retained baseline unavailable");
    await owner.refresh();
    await this.runtime.observeQualifiedExecutions!();
    const current = this.runtime.getLoadedReceipt?.(held.claim.pluginId) ?? null;
    if (current && !isDeepStrictEqual(current, first.state.currentReceipt))
      throw new Error("Known failure loaded receipt ambiguous");
    const latest = await policy.authorize(
      held.claim.pluginId,
      held.claim.path,
      ticket.authorization.operation,
      undefined,
      ticket,
    );
    if (latest?.policyRevision !== ticket.policyRevision)
      throw new Error("Known failure policy changed");
    const last = await policy.observeStatus(held.claim.pluginId);
    assertPluginHeldOperation(held, held.claim.pluginId, held.claim.path);
    if (
      first.identity !== last.identity ||
      this.configStore.get() !== config ||
      current !== (this.runtime.getLoadedReceipt?.(held.claim.pluginId) ?? null) ||
      !readSettledQualifiedCompilerFailure(failure, owner, held)
    )
      throw new Error("Known failure changed during certification");
    const incarnation = owner.binding.expectedIncarnation;
    if (typeof incarnation !== "string" || !incarnation)
      throw new Error("Known failure owner incarnation unavailable");
    const observation = freezeKnownFailedHeld({
      outcome: "known_failed_held",
      reason: "compiler_error",
      pluginId: held.claim.pluginId,
      nativeGeneration: last.state.generation,
      current: {
        registration: observeKnownFailureRegistration(config, held.claim.pluginId),
        loaded: current,
      },
      baseline: {
        path: baseline.source.path,
        snapshotSha256: baseline.receipt.snapshotSha256,
        serverBundleSha256: baseline.receipt.serverBundleSha256,
      },
    });
    knownFailedHeldResults.set(observation, {
      owner,
      incarnation,
      service: this,
      held,
      observation,
      compilerFailure: failure,
      epoch: null,
    });
    return observation;
  }

  private async assertHeldSource(held: PluginHeldOperation, expectedPath: string): Promise<void> {
    assertPluginHeldOperation(held, held.claim.pluginId, held.claim.path);
    const source = this.requireSource(held.claim.pluginId);
    if (
      source.path !== expectedPath ||
      this.pendingOperations.has(held.claim.pluginId) ||
      this.configStore.get().pluginsEnabled !== true
    )
      throw new Error("Held plugin registration changed");
  }
  private async assertHeldCas(held: PluginHeldOperation, expectedPath: string): Promise<void> {
    await this.assertHeldSource(held, expectedPath);
    if (
      (await this.dependencies.activationPolicy!.status(held.claim.pluginId)).generation !==
      held.claim.expectedGeneration
    )
      throw new Error("Held plugin activation CAS changed");
  }
  private async launchHeldPlugin(
    held: PluginHeldOperation,
    operation: ActivationOperation,
  ): Promise<void> {
    const { claim } = held;
    await this.runtime.startPlugin(
      claim.pluginId,
      claim.path,
      () => {
        assertPluginHeldOperation(held, claim.pluginId, claim.path);
        return (
          this.requireSource(claim.pluginId).path === claim.expectedPath &&
          this.configStore.get().pluginsEnabled === true &&
          !this.pendingOperations.has(claim.pluginId)
        );
      },
      operation,
      held,
    );
    await this.publishProviderRegistrations(claim.pluginId, claim.path);
    this.publishUsageSources(claim.pluginId);
  }
  private stopHeldPlugin(held: PluginHeldOperation): Promise<boolean> {
    this.removeProviderRegistrations(held.claim.pluginId);
    this.removeUsageSources(held.claim.pluginId);
    return this.runtime.stopPluginById(held.claim.pluginId, held);
  }
  private async holdFailedPlugin(held: PluginHeldOperation): Promise<void> {
    try {
      await this.stopHeldPlugin(held);
    } finally {
      await this.dependencies.activationPolicy!.hold(held.claim.pluginId);
    }
  }
  private async finishHeldPluginOperation(
    held: PluginHeldOperation,
  ): Promise<HeldPluginDriverResult> {
    assertPluginHeldOperation(held, held.claim.pluginId, held.claim.path);
    await this.runtime.observeQualifiedExecutions!();
    const plugin = await this.requireItem(held.claim.pluginId);
    const state = await this.dependencies.activationPolicy!.status(held.claim.pluginId);
    const result = { plugin, nativeGeneration: state.generation };
    assertHeldPluginOperationResult(held.claim, result);
    this.notify(held.claim.pluginId);
    return result;
  }

  async replaceDirectory(input: DirectoryReplacementInput): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const activation = await this.prepareReplacement(input);
      const { pluginId, policy } = activation;
      try {
        const wasRunning = this.runtime.catalog().some((item) => item.id === pluginId);
        await this.stopPlugin(pluginId);
        await this.activateReplacement(activation, wasRunning);
        this.notify(pluginId);
        return this.requireItem(pluginId);
      } finally {
        policy.releaseReplacement(pluginId);
      }
    });
  }

  private async requireManagedBaseline(
    pluginId: string,
    source: PluginSource,
    policy: ManagedPluginActivationPolicy,
  ): Promise<NonNullable<PluginListItem["loaded"]>> {
    const receipt = this.runtime.getLoadedReceipt?.(pluginId);
    if (
      !receipt ||
      receipt.sourcePath !== source.path ||
      !receipt.snapshotRoot ||
      !receipt.snapshotSha256 ||
      receipt.activationGeneration < 1
    )
      throw new Error(
        "Unmanaged adoption held: complete managed baseline evidence is required before disruption",
      );
    const state = await policy.status(pluginId);
    if (!isDeepStrictEqual(state.currentReceipt, receipt))
      throw new Error("Loaded baseline identity is ambiguous");
    return receipt;
  }

  private async prepareReplacement(
    input: DirectoryReplacementInput,
  ): Promise<ReplacementActivation> {
    const { pluginId } = input;
    const source = this.requireEnabledSource(pluginId);
    const policy = this.dependencies.activationPolicy;
    if (!policy) throw new Error("Directory replacement requires managed policy");
    if (source.source !== "directory" || source.path !== input.expectedPath)
      throw new Error("Directory source CAS mismatch");
    if (this.configStore.get().pluginsEnabled !== true)
      throw new Error("Plugins are globally disabled");
    const state = await policy.status(pluginId);
    if (state.generation !== input.expectedGeneration)
      throw new Error("Stale activation generation");
    const candidate = path.resolve(input.path);
    if (candidate === source.path)
      throw new Error("Replacement must use a distinct immutable source");
    const authorization = await policy.authorize(pluginId, candidate);
    if (!authorization) throw new Error("Replacement requires enrolled binary-only authorization");
    await this.checkRequirements(candidate);
    if (!this.runtime.validateActivation)
      throw new Error("Runtime cannot verify managed activation");
    await this.runtime.validateActivation(pluginId, candidate);
    await policy.authorize(pluginId, candidate, "activate", undefined, authorization);
    if (this.requireSource(pluginId).path !== source.path || !this.canPublish(pluginId))
      throw new Error("Source changed during replacement preparation");
    const receipt = await this.requireManagedBaseline(pluginId, source, policy);
    await policy.replacing(pluginId, source.path, candidate, { source, receipt });
    return { pluginId, policy, source, candidate };
  }

  private async activateReplacement(
    input: ReplacementActivation,
    wasRunning: boolean,
  ): Promise<void> {
    const { pluginId, source, candidate, policy } = input;
    try {
      await this.startExplicit(pluginId, candidate);
      if (!this.canPublish(pluginId) || this.requireSource(pluginId).path !== source.path)
        throw new Error("Replacement cancelled");
      await this.patchSource(pluginId, { ...source, path: candidate });
      await policy.committedReplacement(pluginId);
    } catch (error) {
      await this.stopPlugin(pluginId);
      await policy.hold(pluginId);
      if (this.configStore.get().plugins?.[pluginId]?.path !== source.path) {
        throw new Error("Replacement registration changed; recovery required", {
          cause: error,
        });
      }
      if (wasRunning && this.canPublish(pluginId)) {
        try {
          await this.assertRecoveryBaseline(pluginId, source.path);
          await this.startExplicit(pluginId, source.path, "recover");
          await policy.committedReplacement(pluginId);
        } catch (recoveryError) {
          throw new Error("Replacement failed; recovery required", { cause: recoveryError });
        }
      }
      throw error;
    }
  }

  async recoverPlugin(input: PluginRecoveryInput): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const { pluginId } = input;
      const policy = this.dependencies.activationPolicy;
      if (!policy || !this.runtime.validateActivation)
        throw new Error("Managed recovery unavailable");
      const current = this.requireEnabledSource(pluginId);
      const state = await policy.status(pluginId);
      const baseline = state.baseline;
      if (state.generation !== input.expectedGeneration || current.path !== input.expectedPath)
        throw new Error("Recovery generation/source CAS mismatch");
      if (!baseline) throw new Error("Recovery requires a recorded baseline identity");
      const loaded = this.runtime.getLoadedReceipt?.(pluginId);
      await this.inspectRecoveryIdentity({ pluginId, current, state, baseline, loaded, policy });
      try {
        await this.validateRetainedBaseline({ pluginId, baseline, policy });
        if (this.requireSource(pluginId).path !== current.path || !this.canPublish(pluginId))
          throw new Error("Recovery cancelled");
        await policy.recovering(pluginId, input.expectedGeneration);
        await this.stopPlugin(pluginId);
        await this.startExplicit(pluginId, baseline.source.path, "recover");
        if (!this.canPublish(pluginId) || this.requireSource(pluginId).path !== current.path)
          throw new Error("Recovery cancelled after launch");
        await this.patchSource(pluginId, baseline.source);
        await policy.committedReplacement(pluginId);
        this.notify(pluginId);
        return this.requireItem(pluginId);
      } catch (error) {
        // Never disturb an existing child on a preflight refusal; a launched recovery is stopped.
        if (
          this.runtime.getLoadedReceipt?.(pluginId)?.activationGeneration !==
          loaded?.activationGeneration
        )
          await this.stopPlugin(pluginId);
        await policy.hold(pluginId);
        throw error;
      } finally {
        policy.releaseReplacement(pluginId);
      }
    });
  }

  private async inspectRecoveryIdentity(input: RecoveryIdentityInspection): Promise<void> {
    const { pluginId, current, state, baseline, loaded, policy } = input;
    const knownSource =
      current.path === baseline.source.path || current.path === state.candidatePath;
    if (
      !knownSource ||
      (loaded &&
        (!isDeepStrictEqual(loaded, state.currentReceipt) || loaded.sourcePath !== current.path))
    ) {
      await policy.hold(pluginId);
      throw new Error("Loaded/current source identity is ambiguous; recovery held");
    }
  }

  private async validateRetainedBaseline(input: RetainedBaselineValidation): Promise<void> {
    const { pluginId, baseline, policy } = input;
    if (!this.runtime.validateActivation) throw new Error("Managed recovery unavailable");
    const ticket = await policy.authorize(pluginId, baseline.source.path, "recover");
    if (
      !ticket ||
      ticket.authorization.serverBundleSha256 !== baseline.receipt.serverBundleSha256 ||
      ticket.authorization.snapshotSha256 !== baseline.receipt.snapshotSha256 ||
      ticket.authorization.snapshotRoot !== baseline.receipt.snapshotRoot
    )
      throw new Error("Recovery authorization does not match recorded baseline");
    await this.runtime.validateActivation(pluginId, baseline.source.path, "recover");
  }

  async inspectDirectory(configuredPath: string): Promise<{ id: string }> {
    return readPluginManifest(path.resolve(configuredPath));
  }

  async installSource(input: {
    source: string;
    id?: string;
    ref?: string;
  }): Promise<PluginListItem> {
    if (input.id && this.builtinPluginIds.has(input.id)) {
      throw new Error(`Plugin ID "${input.id}" is reserved for a built-in plugin`);
    }
    const reference = parsePluginSourceReference(input.source);
    if (reference.kind === "directory") {
      const directory = path.resolve(expandTilde(reference.source));
      const info = await stat(directory).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`Plugin directory does not exist: ${directory}`);
      if (input.ref) throw new Error("Plugin --ref is only valid for Git sources");
      const pluginDirectory = resolveLocalPluginPath(directory, reference.pluginPath);
      return this.installDirectory({ path: pluginDirectory, id: input.id });
    }
    const managedSources = this.requireManagedSources();
    return this.enqueue(async () => {
      await this.dependencies.activationPolicy?.assertNativeAcquisitionAllowed(input.id);
      let candidate = await managedSources.prepareInstall({
        ...input,
        source: reference.source,
        pluginPath: reference.pluginPath,
      });
      let pluginId: string;
      try {
        await this.checkRequirements(candidate.directory);
        pluginId = PluginIdSchema.parse(input.id ?? candidate.defaultId);
        if (this.builtinPluginIds.has(pluginId)) {
          throw new Error(`Plugin ID "${pluginId}" is reserved for a built-in plugin`);
        }
        if (this.configStore.get().plugins?.[pluginId]) {
          throw new Error(
            `Plugin ID "${pluginId}" is already configured; choose another ID with --id`,
          );
        }
        await this.dependencies.activationPolicy?.assertNativeAcquisitionAllowed(pluginId);
        await runPluginBuild(candidate.directory, candidate.build, this.logger);
        await this.dependencies.activationPolicy?.assertNativeAcquisitionAllowed(pluginId);
        candidate = await managedSources.place(pluginId, candidate);
        await this.validateCandidate(candidate);
        await managedSources.verifyCandidate(pluginId, candidate);
      } catch (error) {
        await managedSources.discard(candidate);
        throw error;
      }
      await this.dependencies.activationPolicy?.authorize(pluginId, candidate.directory);
      await this.patchSource(pluginId, {
        source: "directory",
        path: candidate.directory,
        enabled: true,
      });
      try {
        if (this.canPublish(pluginId)) await this.startExplicit(pluginId, candidate.directory);
        managedSources.commit(pluginId, candidate.record);
      } catch (error) {
        await this.stopPlugin(pluginId);
        await this.removeSource(pluginId);
        await managedSources.discard(candidate);
        this.errors.delete(pluginId);
        this.notify(pluginId);
        throw error;
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async statusSources(pluginId?: string): Promise<PluginSourceStatusItem[]> {
    return this.enqueue(async () => {
      const sources = this.configStore.get().plugins ?? {};
      const selected = pluginId
        ? [[pluginId, this.requireSource(pluginId)] as const]
        : Object.entries(sources);
      const managedSources = this.requireManagedSources();
      const statuses: PluginSourceStatusItem[] = [];
      for (const [id, source] of selected) {
        statuses.push(await managedSources.status(id, source.path));
      }
      return statuses.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  // COMPAT(plugin-immediate-update): added in v0.8.0; remove after 2027-03-16 when clients use reviewed targets.
  async updateSources(_pluginId?: string): Promise<PluginSourceUpdateItem[]> {
    throw new Error("Update the client to review plugin updates before applying them.");
  }

  async previewUpdates(input: {
    pluginId?: string;
    target?: PluginUpdateSelection;
  }): Promise<PluginUpdatePreview[]> {
    if (input.target && !input.pluginId)
      throw new Error("An explicit update target requires one plugin ID");
    const sources = this.configStore.get().plugins ?? {};
    const ids = input.pluginId ? [input.pluginId] : Object.keys(sources).sort();
    return Promise.all(
      ids.map(async (id) => {
        try {
          return await this.requireManagedSources().preview(
            id,
            this.requireSource(id).path,
            input.target,
          );
        } catch (error) {
          return {
            id,
            outcome: "error" as const,
            links: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async applyUpdates(proposals: PluginUpdateProposal[]): Promise<PluginUpdateResult[]> {
    return this.enqueue(async () => {
      const results: PluginUpdateResult[] = [];
      for (const proposal of proposals) {
        try {
          results.push(await this.updateSource(proposal));
        } catch (error) {
          results.push({
            id: proposal.id,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }

  async reloadPlugin(pluginId: string): Promise<PluginListItem> {
    return this.enqueue(async () => {
      const source = this.requireEnabledSource(pluginId);
      if (this.configStore.get().pluginsEnabled !== true) {
        throw new Error("Plugins are globally disabled");
      }
      this.errors.delete(pluginId);
      const ticket = await this.dependencies.activationPolicy?.authorize(pluginId, source.path);
      if (ticket && this.dependencies.activationPolicy)
        await this.requireManagedBaseline(pluginId, source, this.dependencies.activationPolicy);
      await this.stopPlugin(pluginId);
      await this.startExplicit(pluginId, source.path);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async enablePlugin(pluginId: string): Promise<PluginListItem> {
    this.requireLifecycleAdmission();
    await this.patchSource(pluginId, (source) => ({ ...source, enabled: true }));
    this.errors.delete(pluginId);
    return this.enqueue(async () => {
      // Cancellation persistence uses the store queue, so it never waits behind a blocked start.
      await this.pendingOperations.get(pluginId)?.completion.catch(() => {});
      const current = this.requireSource(pluginId);
      if (current.enabled !== false && this.configStore.get().pluginsEnabled === true) {
        await this.startExplicit(pluginId, current.path);
      }
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async disablePlugin(pluginId: string): Promise<PluginListItem> {
    this.requireLifecycleAdmission();
    const operation = {
      kind: "disable",
      completion: this.patchSource(pluginId, (source) => ({ ...source, enabled: false })),
    } as const;
    this.pendingOperations.set(pluginId, operation);
    try {
      await operation.completion;
    } finally {
      if (this.pendingOperations.get(pluginId) === operation)
        this.pendingOperations.delete(pluginId);
    }
    const stopping = this.stopPlugin(pluginId);
    return this.enqueue(async () => {
      await stopping;
      this.errors.delete(pluginId);
      this.notify(pluginId);
      return this.requireItem(pluginId);
    });
  }

  async removePlugin(pluginId: string): Promise<void> {
    this.requireLifecycleAdmission();
    this.requireSource(pluginId);
    const operation = { kind: "remove", completion: this.removeSource(pluginId) } as const;
    this.pendingOperations.set(pluginId, operation);
    try {
      await operation.completion;
    } finally {
      if (this.pendingOperations.get(pluginId) === operation)
        this.pendingOperations.delete(pluginId);
    }
    const stopping = this.stopPlugin(pluginId);
    await this.enqueue(async () => {
      await stopping;
      this.runtime.clearLogs(pluginId);
      this.errors.delete(pluginId);
      this.notify(pluginId);
      await this.managedSources?.remove(pluginId);
      if (this.dependencies.settingsDirectory)
        await rm(path.join(this.dependencies.settingsDirectory, pluginId), {
          recursive: true,
          force: true,
        });
    });
  }

  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown> {
    return this.runtime.invoke(pluginId, method, input);
  }

  subscribePluginRpc(pluginId: string, method: string, input: unknown): PluginRuntimeSubscription {
    return this.runtime.startSubscription(pluginId, method, input);
  }

  async stopAllPlugins(): Promise<void> {
    this.globalStartsBlocked = true;
    const stopping = this.stopAll();
    await this.enqueue(async () => {
      await stopping;
      await this.stopAll();
    });
  }

  private handleGlobalSwitch(enabled: boolean): void {
    if (!enabled) {
      this.globalStartsBlocked = true;
      const stopping = this.stopConfiguredPlugins();
      for (const id of Object.keys(this.configStore.get().plugins ?? {})) this.notify(id);
      void this.enqueue(async () => {
        await stopping;
      }).catch((error) => this.logger.error({ err: error }, "Failed to disable plugins"));
      return;
    }
    void this.enqueue(async () => {
      this.globalStartsBlocked = false;
      for (const [pluginId, source] of Object.entries(this.configStore.get().plugins ?? {})) {
        if (source.enabled !== false) await this.startConfigured(pluginId);
        this.notify(pluginId);
      }
    }).catch((error) => this.logger.error({ err: error }, "Failed to enable plugins"));
  }

  private async startBuiltinDuringBootstrap(plugin: BuiltinPlugin): Promise<void> {
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (!owner || !isQualifiedDaemonOwner(owner)) return this.runtime.startBuiltinPlugin?.(plugin);
    const native = this.dependencies.nativeMaintenance;
    if (!native) throw new Error("Qualified builtin initialization unavailable");
    return runQualifiedPluginInitialization(
      owner,
      native,
      plugin.id,
      plugin.directory,
      (initialization) => this.runtime.startBuiltinPlugin!(plugin, initialization),
    );
  }
  private async startConfiguredDuringBootstrap(
    pluginId: string,
    publishTurn?: Promise<unknown>,
  ): Promise<void> {
    const source = this.requireEnabledSource(pluginId);
    try {
      const ticket = await this.dependencies.activationPolicy?.authorize(pluginId, source.path);
      if (!ticket?.authorization.passiveProfile) return this.startConfigured(pluginId, publishTurn);
      const owner = this.dependencies.qualifiedDaemonOwner;
      const native = this.dependencies.nativeMaintenance;
      if (!owner || !isQualifiedDaemonOwner(owner) || !native)
        throw new Error("Qualified plugin initialization unavailable");
      await runQualifiedPluginInitialization(
        owner,
        native,
        pluginId,
        source.path,
        (initialization) => this.startConfigured(pluginId, publishTurn, initialization),
      );
    } catch (error) {
      this.recordFailure(pluginId, error);
    }
  }

  private async startConfigured(
    pluginId: string,
    publishTurn?: Promise<unknown>,
    initialization?: QualifiedPluginInitialization,
  ): Promise<void> {
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source || source.enabled === false || !this.canPublish(pluginId)) return;
    this.errors.delete(pluginId);
    try {
      await this.startPlugin(pluginId, source.path, publishTurn, "activate", initialization);
    } catch (error) {
      if (this.canPublish(pluginId)) this.recordFailure(pluginId, error);
    }
  }

  private async assertRecoveryBaseline(pluginId: string, sourcePath: string): Promise<void> {
    const policy = this.dependencies.activationPolicy;
    if (!policy) return;
    const state = await policy.status(pluginId);
    // Unmanaged compatibility has no recorded enrollment or policy ticket.
    const ticket = await policy.authorize(pluginId, sourcePath, "recover");
    if (!ticket) return;
    const baseline = state.baseline;
    if (
      !baseline ||
      baseline.source.path !== sourcePath ||
      ticket.authorization.serverBundleSha256 !== baseline.receipt.serverBundleSha256 ||
      ticket.authorization.snapshotSha256 !== baseline.receipt.snapshotSha256 ||
      ticket.authorization.snapshotRoot !== baseline.receipt.snapshotRoot
    )
      throw new Error("Recovery authorization does not match recorded baseline");
  }

  private async startExplicit(
    pluginId: string,
    sourcePath: string,
    operation: ActivationOperation = "activate",
  ): Promise<void> {
    try {
      await this.startPlugin(pluginId, sourcePath, undefined, operation);
    } catch (error) {
      if (this.canPublish(pluginId)) {
        this.recordFailure(pluginId, error);
        this.notify(pluginId);
      }
      throw error;
    }
  }

  private canPublish(pluginId: string): boolean {
    const config = this.configStore.get();
    return (
      !this.pendingOperations.has(pluginId) &&
      !this.globalStartsBlocked &&
      config.pluginsEnabled === true &&
      config.plugins?.[pluginId]?.enabled !== false &&
      config.plugins?.[pluginId] !== undefined
    );
  }

  private async startPlugin(
    pluginId: string,
    sourcePath: string,
    publishTurn?: Promise<unknown>,
    operation: ActivationOperation = "activate",
    initialization?: QualifiedPluginInitialization,
  ): Promise<void> {
    await this.dependencies.activationPolicy?.authorize(pluginId, sourcePath, operation);
    await this.runtime.startPlugin(
      pluginId,
      sourcePath,
      () => this.canPublish(pluginId),
      operation,
      undefined,
      initialization,
    );
    await publishTurn;
    try {
      await this.publishProviderRegistrations(pluginId, sourcePath);
      this.publishUsageSources(pluginId);
    } catch (error) {
      try {
        this.removeProviderRegistrations(pluginId);
        this.removeUsageSources(pluginId);
      } finally {
        await this.runtime.stopPluginById(pluginId);
      }
      throw error;
    }
  }

  private stopPlugin(pluginId: string): Promise<boolean> {
    this.removeProviderRegistrations(pluginId);
    this.removeUsageSources(pluginId);
    return this.runtime.stopPluginById(pluginId);
  }

  private async stopConfiguredPlugins(): Promise<void> {
    const stopping = Object.keys(this.configStore.get().plugins ?? {}).map((id) =>
      this.stopPlugin(id),
    );
    await Promise.all(stopping);
  }

  private async stopAll(): Promise<void> {
    for (const pluginId of this.providerIdsByPlugin.keys()) {
      this.removeProviderRegistrations(pluginId);
    }
    for (const pluginId of this.usageSourceIdsByPlugin.keys()) this.removeUsageSources(pluginId);
    await this.runtime.stopAll();
  }

  private publishUsageSources(pluginId: string): void {
    const metadata = this.runtime.getUsageSourceRegistrations(pluginId);
    const registered: string[] = [];
    try {
      for (const source of metadata) {
        this.usageSources.register({
          id: source.id,
          label: source.label,
          icon: source.icon,
          discover: async (scope) => {
            const result = await this.runtime.discoverUsage(pluginId, source.id, scope);
            if (!Array.isArray(result))
              throw new Error(`Invalid usage discovery from ${source.id}`);
            return result;
          },
          fetch: (input) => {
            return this.runtime.fetchUsage(pluginId, source.id, input);
          },
        });
        registered.push(source.id);
      }
    } catch (error) {
      for (const id of registered) this.usageSources.unregister(id);
      throw error;
    }
    this.usageSourceIdsByPlugin.set(pluginId, registered);
  }

  private removeUsageSources(pluginId: string): void {
    for (const id of this.usageSourceIdsByPlugin.get(pluginId) ?? [])
      this.usageSources.unregister(id);
    this.usageSourceIdsByPlugin.delete(pluginId);
  }

  private async publishProviderRegistrations(
    pluginId: string,
    pluginDirectory: string,
  ): Promise<void> {
    const metadata = this.runtime.getProviderRegistrations?.(pluginId) ?? [];
    for (const provider of metadata) {
      if (BUILTIN_PROVIDER_ID_SET.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register builtin provider ID "${provider.id}"`);
      }
      if (this.providers.has(provider.id)) {
        throw new Error(`Plugin ${pluginId} cannot register provider ID "${provider.id}" twice`);
      }
    }
    const registrations = await Promise.all(
      metadata.map(
        async (provider): Promise<ProviderRegistration> => ({
          id: provider.id,
          label: provider.label,
          description: provider.description,
          command: provider.command,
          requiresConfiguration: provider.requiresConfiguration,
          status: provider.hasStatus
            ? (request) => {
                if (!this.runtime.getProviderStatus)
                  throw new Error("Plugin runtime cannot resolve provider status");
                return this.runtime.getProviderStatus(pluginId, provider.id, request);
              }
            : undefined,
          getCatalogCacheKey: provider.hasCatalogCacheKey
            ? (options) => {
                if (!this.runtime.getProviderCatalogCacheKey)
                  throw new Error("Plugin runtime cannot resolve catalogue keys");
                return this.runtime.getProviderCatalogCacheKey(pluginId, provider.id, options);
              }
            : undefined,
          icon: provider.iconPath
            ? await readPluginProviderIcon(pluginDirectory, provider.iconPath)
            : undefined,
          connect: (request) => this.runtime.connectProvider(pluginId, provider.id, request),
        }),
      ),
    );
    const ids = registrations.map((provider) => provider.id);
    for (const provider of registrations) {
      this.providers.set(provider.id, {
        ...provider,
      });
    }
    if (ids.length > 0) {
      this.providerIdsByPlugin.set(pluginId, ids);
      this.notifyProviderRegistrations();
    }
  }

  private removeProviderRegistrations(pluginId: string): void {
    const ids = this.providerIdsByPlugin.get(pluginId);
    if (!ids) return;
    this.providerIdsByPlugin.delete(pluginId);
    for (const id of ids) this.providers.delete(id);
    this.notifyProviderRegistrations();
  }

  private notifyProviderRegistrations(): void {
    for (const listener of this.providerListeners) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.requireLifecycleAdmission();
    const release = this.dependencies.nativeMaintenance?.enterWork();
    const admitted = async () => {
      this.qualifiedEpoch++;
      this.qualifiedMutations++;
      try {
        return await operation();
      } finally {
        this.qualifiedMutations--;
        this.qualifiedEpoch++;
      }
    };
    const result = this.lifecycle.then(admitted, admitted).finally(() => release?.());
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recordFailure(pluginId: string, error: unknown): void {
    this.errors.set(pluginId, error instanceof Error ? error.message : String(error));
  }

  private async checkRequirements(directory: string): Promise<void> {
    const manifest = await readPluginManifest(directory);
    assertPluginCompatibility({ ...manifest, version: this.daemonVersion, runtime: "daemon" });
  }

  private async updateSource(proposal: PluginUpdateProposal): Promise<PluginUpdateResult> {
    const pluginId = proposal.id;
    const managedSources = this.requireManagedSources();
    const source = this.requireSource(pluginId);
    const policy = this.dependencies.activationPolicy;
    await policy?.assertNativeAcquisitionAllowed(pluginId);
    let candidate = await managedSources.prepareUpdate(proposal, source.path);
    try {
      await this.checkRequirements(candidate.directory);
      await policy?.assertNativeAcquisitionAllowed(pluginId);
      await runPluginBuild(candidate.directory, candidate.build, this.logger);
      await policy?.assertNativeAcquisitionAllowed(pluginId);
      candidate = await managedSources.place(pluginId, candidate);
      await this.validateCandidate(candidate);
      await managedSources.verifyCandidate(pluginId, candidate, proposal.target);
      await managedSources.assertCurrent(proposal, this.requireSource(pluginId).path);
      await policy?.assertNativeAcquisitionAllowed(pluginId);
    } catch (error) {
      await managedSources.discard(candidate);
      throw error;
    }
    return this.activateNativeUpdate({ pluginId, source, candidate, managedSources });
  }

  private async activateNativeUpdate(input: NativeUpdateActivation): Promise<PluginUpdateResult> {
    const { pluginId, candidate } = input;
    const current = this.requireSource(pluginId);
    const isRunning = this.runtime.catalog().some((plugin) => plugin.id === pluginId);
    const shouldActivate =
      current.enabled !== false && this.configStore.get().pluginsEnabled === true;
    await this.dependencies.activationPolicy?.assertNativeAcquisitionAllowed(pluginId);
    await this.dependencies.activationPolicy?.authorize(pluginId, candidate.directory);
    if (shouldActivate && isRunning) await this.stopPlugin(pluginId);
    try {
      if (shouldActivate) await this.startExplicit(pluginId, candidate.directory);
      if (!this.configStore.get().plugins?.[pluginId])
        throw new Error(`Plugin is no longer configured: ${pluginId}`);
      await this.patchSource(pluginId, (currentSource) => ({
        ...currentSource,
        path: candidate.directory,
      }));
    } catch (error) {
      await this.stopPlugin(pluginId);
      await this.restoreNativeUpdate({ ...input, wasRunning: isRunning, failure: error });
      throw error;
    }
    this.errors.delete(pluginId);
    this.notify(pluginId);
    const warning = await this.cleanupNativeUpdate(input);
    return {
      id: pluginId,
      outcome: "updated",
      plugin: await this.requireItem(pluginId),
      ...(warning ? { warning } : {}),
    };
  }

  private async restoreNativeUpdate(input: NativeUpdateRecovery): Promise<void> {
    const { pluginId, source, candidate, managedSources, wasRunning, failure } = input;
    try {
      if (
        wasRunning &&
        this.canPublish(pluginId) &&
        this.requireSource(pluginId).path === source.path
      ) {
        await this.assertRecoveryBaseline(pluginId, source.path);
        await this.startExplicit(pluginId, source.path, "recover");
      }
    } catch (error) {
      throw new Error(
        `Update failed: ${failure instanceof Error ? failure.message : String(failure)}; restoring previous plugin also failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      if (this.configStore.get().plugins?.[pluginId]?.path !== candidate.directory)
        await managedSources.discard(candidate);
      this.notify(pluginId);
    }
  }

  private async cleanupNativeUpdate(input: NativeUpdateActivation): Promise<string | undefined> {
    try {
      await input.managedSources.removeVersion(input.pluginId, input.source.path);
      return undefined;
    } catch (error) {
      return `Plugin updated, but previous installation cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private validateCandidate(candidate: ManagedPluginCandidate): Promise<void> {
    if (!this.runtime.validatePlugin) {
      throw new Error("Plugin runtime cannot validate managed sources");
    }
    return this.runtime.validatePlugin(candidate.directory);
  }

  private requireManagedSources(): ManagedPluginSources {
    if (!this.managedSources) throw new Error("Plugin source management is unavailable");
    return this.managedSources;
  }

  private requireSource(pluginId: string): PluginSource {
    PluginIdSchema.parse(pluginId);
    const source = this.configStore.get().plugins?.[pluginId];
    if (!source) throw new Error(`Plugin is not configured: ${pluginId}`);
    return source;
  }

  private requireEnabledSource(pluginId: string): PluginSource {
    const source = this.requireSource(pluginId);
    if (source.enabled === false) throw new Error(`Plugin is disabled: ${pluginId}`);
    return source;
  }

  private async patchSource(
    pluginId: string,
    update: PluginSource | ((source: PluginSource) => PluginSource),
  ): Promise<void> {
    await this.configStore.patch((current) => {
      const source = current.plugins?.[pluginId];
      if (typeof update === "function" && !source)
        throw new Error(`Plugin is not configured: ${pluginId}`);
      return {
        plugins: {
          ...current.plugins,
          [pluginId]: typeof update === "function" ? update(source!) : update,
        },
      };
    });
  }

  private async removeSource(pluginId: string): Promise<void> {
    await this.configStore.patch((current) => {
      const sources = { ...current.plugins };
      delete sources[pluginId];
      return { plugins: sources };
    });
  }

  private async requireItem(pluginId: string): Promise<PluginListItem> {
    const item = (await this.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!item) throw new Error(`Plugin is not configured: ${pluginId}`);
    return item;
  }

  private notify(pluginId: string): void {
    for (const listener of this.listeners) listener(pluginId);
  }
}

function resolveLocalPluginPath(directory: string, pluginPath: string | undefined): string {
  if (!pluginPath) return directory;
  if (path.isAbsolute(pluginPath)) throw new Error("Plugin path must be relative to the source");
  const pluginDirectory = path.resolve(directory, pluginPath);
  const relative = path.relative(directory, pluginDirectory);
  const escapesSource =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesSource) throw new Error("Plugin path must stay inside the source directory");
  return pluginDirectory;
}

const qualifiedServices = new WeakMap<QualifiedDaemonOwner, PluginService>();
export function getQualifiedRuntimeMeasurementEpoch(owner: QualifiedDaemonOwner): number | null {
  if (!isQualifiedDaemonOwner(owner)) return null;
  try {
    owner.assertFresh();
    return qualifiedServices.get(owner)?.getQualifiedObservationEpoch(owner) ?? null;
  } catch {
    return null;
  }
}
export async function getQualifiedRuntimeMeasurement(owner: QualifiedDaemonOwner) {
  try {
    return await captureQualifiedRuntimeMeasurement(owner);
  } catch {
    return null;
  }
}
/** Fixed V2 observer. No mutation, paths, selectors or qualification capability are accepted. */
export async function getQualifiedRuntimeMeasurementV2(owner: QualifiedDaemonOwner) {
  try {
    return await captureQualifiedRuntimeMeasurement(owner, 2);
  } catch {
    return null;
  }
}
async function captureQualifiedRuntimeMeasurement(owner: QualifiedDaemonOwner, version: 1 | 2 = 1) {
  if (!isQualifiedDaemonOwner(owner)) return null;
  const service = qualifiedServices.get(owner);
  if (!service) return null;
  const epoch = getQualifiedRuntimeMeasurementEpoch(owner);
  if (epoch === null) return null;
  const plugins =
    version === 2
      ? await service.getManagedPluginCohortV2Status()
      : await service.getManagedPluginCohortStatus();
  const runs = getQualifiedCompilerObservations(owner);
  let coldPair: [number, number] | null = null;
  if (runs)
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]!;
        const b = runs[j]!;
        if (
          a.threadId !== b.threadId &&
          a.incarnation !== b.incarnation &&
          a.sourceDirectory === b.sourceDirectory &&
          a.snapshotRoot === b.snapshotRoot &&
          a.snapshotSha256 === b.snapshotSha256 &&
          a.serverBundleSha256 === b.serverBundleSha256 &&
          a.clientBundleSha256 === b.clientBundleSha256 &&
          isDeepStrictEqual(a.closure, b.closure)
        )
          coldPair = [i, j];
      }
  if (epoch !== getQualifiedRuntimeMeasurementEpoch(owner)) return null;
  return {
    version,
    observationEpoch: epoch,
    compiler: runs ? { runs, coldPair } : null,
    plugins,
  };
}

type CohortV2Entry = Extract<
  ManagedPluginCohortV2Status,
  { consistency: "coherent" }
>["entries"][number];
function assembleCohortV2Entries(
  directories: CohortEntry[],
  builtins: ReturnType<PluginRuntime["observeBuiltinCohort"]>,
  expectedBuiltins: ReadonlySet<string>,
  root: string,
): CohortV2Entry[] {
  if ([...builtins.keys()].some((id) => !expectedBuiltins.has(id)))
    throw new Error("Unexpected builtin instance");
  const entries: CohortV2Entry[] = directories.map((item) => ({
    kind: "directory",
    pluginId: item.pluginId,
    registration: item.registration,
    enabled: item.enabled,
    journal: item.journal,
    loaded: item.loaded ? { kind: "plugin-child", receipt: item.loaded } : null,
    execution: item.execution
      ? Object.assign({ kind: "plugin-child" as const }, item.execution)
      : null,
  }));
  for (const pluginId of expectedBuiltins)
    entries.push(
      builtins.get(pluginId) ?? {
        kind: "builtin-in-process",
        pluginId,
        registration: { path: path.join(root, "builtin-plugins", pluginId) },
        enabled: true,
        loaded: null,
        execution: null,
      },
    );
  return entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

type CohortEntry = Extract<
  ManagedPluginCohortStatus,
  { consistency: "coherent" }
>["entries"][number];
type JournalObservation = Awaited<ReturnType<ManagedPluginActivationPolicy["observeStatus"]>>;
async function readCohortJournal(
  policy: ManagedPluginActivationPolicy,
  id: string,
  required: boolean,
): Promise<JournalObservation | null> {
  try {
    return await policy.observeStatus(id);
  } catch (error) {
    if (required || !(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return null;
  }
}
async function captureCohortEntries(input: {
  ids: string[];
  policy: ManagedPluginActivationPolicy;
  enrollmentIds: string[];
  config: ReturnType<DaemonConfigStore["get"]>;
  builtinIds: ReadonlySet<string>;
  executions: Map<string, NonNullable<CohortEntry["execution"]>>;
  loaded: (id: string) => CohortEntry["loaded"];
}) {
  const entries: CohortEntry[] = [];
  const journals = new Map<string, JournalObservation | null>();
  for (const pluginId of input.ids) {
    const journal = await readCohortJournal(
      input.policy,
      pluginId,
      input.enrollmentIds.includes(pluginId),
    );
    journals.set(pluginId, journal);
    const loaded = input.loaded(pluginId);
    const execution = input.executions.get(pluginId) ?? null;
    if (Boolean(loaded) !== Boolean(execution)) throw new Error("Incomplete executing cohort");
    const registration = input.config.plugins?.[pluginId] ?? null;
    let enabled: boolean | null = null;
    if (registration)
      enabled = input.config.pluginsEnabled === true && registration.enabled !== false;
    else if (input.builtinIds.has(pluginId)) enabled = true;
    entries.push({
      pluginId,
      registration,
      enabled,
      journal: journal?.state ?? null,
      loaded,
      execution,
    });
  }
  return { entries, journals };
}
async function recheckCohortJournals(
  policy: ManagedPluginActivationPolicy,
  journals: Map<string, JournalObservation | null>,
) {
  for (const [id, journal] of journals) {
    const latest = await readCohortJournal(policy, id, journal !== null);
    if ((journal?.identity ?? null) !== (latest?.identity ?? null))
      throw new Error("Cohort journal changed");
  }
}

interface KnownFailedHeldRecord {
  owner: QualifiedDaemonOwner;
  incarnation: string;
  service: PluginService;
  held: PluginHeldOperation;
  observation: KnownFailedHeldObservation;
  compilerFailure: SettledQualifiedCompilerFailure;
  epoch: number | null;
}
const knownFailedHeldResults = new WeakMap<object, KnownFailedHeldRecord>();
function freezeKnownFailedHeld(value: KnownFailedHeldObservation): KnownFailedHeldObservation {
  return Object.freeze({
    ...value,
    current: Object.freeze({
      registration: value.current.registration
        ? Object.freeze({ ...value.current.registration })
        : null,
      loaded: value.current.loaded ? Object.freeze({ ...value.current.loaded }) : null,
    }),
    baseline: Object.freeze({ ...value.baseline }),
  });
}
/** Read-only native consumption of a normal return from the actual settled driver. */
export function readKnownFailedHeld(
  result: unknown,
  scope: HeldPluginOperationScope,
  claim: HeldPluginOperationClaim,
): KnownFailedHeldObservation | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = knownFailedHeldResults.get(result);
  if (!record) {
    if ("outcome" in result) throw new Error("Unbranded known held outcome");
    return undefined;
  }
  assertHeldPluginOperation(scope, claim);
  if (
    record.held.scope !== scope ||
    !isDeepStrictEqual(record.held.claim, claim) ||
    claim.operation === "verify" ||
    record.owner.binding.expectedIncarnation !== record.incarnation ||
    qualifiedServices.get(record.owner) !== record.service ||
    record.epoch === null ||
    record.epoch !== record.service.getQualifiedObservationEpoch(record.owner) ||
    !readSettledQualifiedCompilerFailure(record.compilerFailure, record.owner, record.held)
  )
    throw new Error("Stale known held outcome");
  record.owner.assertFresh();
  return freezeKnownFailedHeld(record.observation);
}

function observeKnownFailureRegistration(
  config: ReturnType<DaemonConfigStore["get"]>,
  pluginId: string,
): KnownFailedHeldObservation["current"]["registration"] {
  const source = config.plugins?.[pluginId];
  if (!source) return null;
  return { path: source.path, enabled: config.pluginsEnabled === true && source.enabled !== false };
}
