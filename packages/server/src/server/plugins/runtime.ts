import {
  assertQualifiedPluginInitialization,
  type QualifiedPluginInitialization,
} from "./qualified-initialization.js";
import { assertPluginHeldOperation, type PluginHeldOperation } from "./held-operation.js";
import {
  isQualifiedDaemonOwner,
  createQualifiedBuiltinInstance,
  assertQualifiedBuiltinInstance,
  getQualifiedBuiltinObservation,
} from "../execution/qualified-host.js";
import type { QualifiedDaemonOwner, QualifiedOwnedChild } from "../execution/daemon-types.js";
import type {
  ManagedPluginCohortV2Entry,
  ManagedPluginCohortExecution,
} from "@getpaseo/protocol/messages";
import { PluginExecutionOwner } from "./execution-owner.js";
import { isPluginExecutionRoot } from "./execution-roots.js";
import {
  samePluginMaintenanceIdentity,
  type NativePluginAdmission,
  type PluginMaintenanceIdentity,
  type PluginMaintenancePort,
} from "./maintenance.js";
import { realpath } from "node:fs/promises";
import {
  ManagedPluginActivationPolicy,
  type ActivationOperation,
  type ActivationTicket,
  type PassivePluginProfile,
} from "./activation-policy.js";
import type { PluginLoadedReceipt } from "@getpaseo/protocol/messages";
import { validateWorktreePath } from "../../utils/worktree-path.js";
import type { PluginHookPayload } from "@getpaseo/plugin/server";
import type { PluginWireBeforeRequests, PluginBeforeResults } from "./lifecycle/index.js";
import type { SessionOpenWireRequest, AttachedAgentTool } from "./agent-tools.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import {
  ProviderStatusSchema,
  type ProviderStatus,
  type ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";
import type { PluginHookEvents, PluginHookAgent, AgentToolResult } from "@getpaseo/plugin/server";
import { validateBeforeRequest, validateBeforeResult } from "./lifecycle/index.js";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type pino from "pino";
import {
  PROVIDER_CAPABILITIES,
  requireProviderCapabilities,
  type ProviderConnectRequest,
  type ProviderCatalogOptions,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import type { PluginLogEntry } from "@getpaseo/protocol/messages";
import {
  compileDirectoryPlugin,
  compileQualifiedDirectoryPlugin,
  compileQualifiedInitialDirectoryPlugin,
  tryCompileQualifiedDirectoryPlugin,
} from "./compiler.js";
import type { PluginRequirements } from "@getpaseo/protocol/messages";
import type {
  PluginProcessMessage,
  PluginProcessRequest,
  PluginProviderMetadata,
  PluginUsageSourceMetadata,
} from "./plugin-process-protocol.js";
import { PluginProcessMessageSchema } from "./plugin-process-protocol.js";
import {
  BufferedPluginSubscription,
  type PluginRuntimeSubscription,
} from "./runtime-subscription.js";
import { PluginSessionSocket } from "./session-socket.js";
import { InternalPluginChild } from "./internal-child.js";
import { evaluateBundle } from "./bundle-evaluator.js";

const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;
const SOFT_SHUTDOWN_TIMEOUT_MS = 2_000;

interface PluginOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface PluginChild {
  pid?: number;
  connected: boolean;
  killed: boolean;
  stdout?: PluginOutputStream | null;
  stderr?: PluginOutputStream | null;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingInvocation {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DirectoryCompilation {
  pluginId: string;
  configuredPath: string;
  directory: string;
  operation: ActivationOperation;
  ticket: ActivationTicket | undefined;
  bundles: Awaited<ReturnType<typeof compileDirectoryPlugin>>;
}
interface ServerPluginActivation {
  held?: PluginHeldOperation;
  initialization?: QualifiedPluginInitialization;
  canPublish: () => boolean;
  pluginId: string;
  configuredPath: string;
  directory: string;
  operation: ActivationOperation;
  ticket: ActivationTicket | undefined;
  serverBundle: string;
  clientBundle: string;
  requirements: PluginRequirements | undefined;
}

interface ChildTermination {
  closed: boolean;
  completion: Promise<void>;
}

interface LoadedPlugin {
  qualifiedChild?: QualifiedOwnedChild;
  builtinInstance?: { child: InternalPluginChild; directory: string };
  activationTicket?: ActivationTicket;
  executionOwner?: PluginExecutionOwner;
  termination?: ChildTermination;
  loadedReceipt?: PluginLoadedReceipt;
  id: string;
  instanceId: string;
  requirements: PluginRequirements | undefined;
  clientBundle: string;
  /** Lets a client that already holds this bundle skip downloading it again. */
  clientBundleHash: string;
  methods: ReadonlySet<string>;
  subscriptionMethods: ReadonlySet<string>;
  subscriptions: Map<string, BufferedPluginSubscription>;
  hooks: string[];
  providers: readonly PluginProviderMetadata[];
  usageSources: readonly PluginUsageSourceMetadata[];
  child: PluginChild | null;
  outputCapture: PluginOutputCapture | null;
  pending: Map<string, PendingInvocation>;
  providerConnections: Map<string, RemoteProviderConnection>;
  providerConnectionTombstones: Set<string>;
  sessionSocket: PluginSessionSocket | null;
  sessionClosed: Promise<void> | null;
}

/** The session socket a loaded plugin currently speaks through. */
interface PluginSessionBinding {
  socket: PluginSessionSocket;
  reattaching: boolean;
  plugin: LoadedPlugin | null;
}

interface PluginFrameInput {
  session: PluginSessionBinding;
  pluginId: string;
  child: PluginChild;
  sessionHost: PluginPaseoSessionHost;
  frame: string | Uint8Array;
  isBinary: boolean;
}

interface PendingProviderSend {
  input: ProviderInput;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface RemoteProviderConnection {
  request: ProviderConnectRequest;
  capabilities: readonly string[];
  listeners: Set<(event: ProviderEvent) => void>;
  pendingSends: Map<string, PendingProviderSend>;
  sessions: Map<string, readonly string[]>;
  connected: boolean;
  closed: boolean;
  closedPromise: Promise<void>;
  resolveConnected(connection: ProviderConnection): void;
  rejectConnected(error: Error): void;
  resolveClosed(): void;
  rejectClosed(error: Error): void;
}

interface PluginRuntimeDependencies {
  qualifiedDaemonOwner?: QualifiedDaemonOwner;
  nativeMaintenance?: NativePluginAdmission;
  activationPolicy?: ManagedPluginActivationPolicy;
  settingsDirectory?: string;
  onSettingsChanged?: (pluginId: string, settingsId: string) => void;
  spawnChild?: () => PluginChild;
  sessionHost?: PluginPaseoSessionHost;
}

interface PluginLogTail {
  entries: PluginLogEntry[];
  bytes: number;
  nextSequence: number;
}

class PluginOutputCapture {
  private readonly pending = new Map<PluginLogEntry["stream"], Buffer>([
    ["stdout", Buffer.alloc(0)],
    ["stderr", Buffer.alloc(0)],
  ]);
  private readonly overflowed = new Set<PluginLogEntry["stream"]>();
  private readonly lastActivity = new Map<PluginLogEntry["stream"], number>();
  private activitySequence = 0;
  private flushed = false;

  constructor(
    child: PluginChild,
    private readonly emit: (stream: PluginLogEntry["stream"], message: string) => void,
  ) {
    child.stdout?.on("data", (chunk) => this.write("stdout", chunk));
    child.stderr?.on("data", (chunk) => this.write("stderr", chunk));
    child.on("close", () => this.flush());
  }

  private write(stream: PluginLogEntry["stream"], chunk: Buffer | string): void {
    if (this.flushed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline === -1 ? data.length : newline;
      this.append(stream, data.subarray(offset, end));
      if (newline === -1) return;
      this.emitLine(stream);
      offset = newline + 1;
    }
  }

  private append(stream: PluginLogEntry["stream"], chunk: Buffer): void {
    if (chunk.length > 0) this.lastActivity.set(stream, ++this.activitySequence);
    const current = this.pending.get(stream) ?? Buffer.alloc(0);
    const remaining = MAX_LOG_LINE_BYTES - current.length;
    if (chunk.length > remaining) this.overflowed.add(stream);
    if (remaining <= 0) return;
    this.pending.set(stream, Buffer.concat([current, chunk.subarray(0, remaining)]));
  }

  private emitLine(stream: PluginLogEntry["stream"]): void {
    let line = this.pending.get(stream) ?? Buffer.alloc(0);
    if (!this.overflowed.has(stream) && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    this.emit(stream, line.toString("utf8"));
    this.pending.set(stream, Buffer.alloc(0));
    this.overflowed.delete(stream);
    this.lastActivity.delete(stream);
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const pendingStreams = (["stdout", "stderr"] as const)
      .filter(
        (stream) => (this.pending.get(stream)?.length ?? 0) > 0 || this.overflowed.has(stream),
      )
      .sort(
        (left, right) => (this.lastActivity.get(left) ?? 0) - (this.lastActivity.get(right) ?? 0),
      );
    for (const stream of pendingStreams) {
      this.emitLine(stream);
    }
  }
}

export interface PluginPaseoSessionHost {
  attachPluginSocket(
    pluginId: string,
    socket: PluginSessionSocket,
  ): Promise<{ closed: Promise<void> }>;
}

function resolveWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts") ? "./plugin-process.ts" : "./plugin-process.js",
    import.meta.url,
  );
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function spawnPluginChild(environment?: NodeJS.ProcessEnv): PluginChild {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    ...(environment ? { env: environment } : {}),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  }) as PluginChild;
}

// Kill only. Node never emits "close" for a child whose IPC channel the parent disconnected, and
// "close" is how the runtime learns that a plugin exited; the channel closes with the process.
function terminatePluginChild(child: PluginChild): void {
  if (!child.killed) child.kill();
}

function hashClientBundle(clientBundle: string): string {
  return createHash("sha256").update(clientBundle).digest("hex");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonTransportValue<Value>(value: Value): Value {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
  return JSON.parse(encoded) as Value;
}

const childExecutionOwners = new WeakMap<PluginChild, PluginExecutionOwner>();
function send(child: PluginChild, message: PluginProcessRequest): Promise<void> {
  if (!child.connected) return Promise.reject(new Error("Plugin child is disconnected"));
  const owner = childExecutionOwners.get(child);
  const root = isPluginExecutionRoot(message);
  return new Promise((resolve, reject) => {
    try {
      if (root) owner?.admit(message);
    } catch (error) {
      reject(error);
      return;
    }
    try {
      const dispatch = () =>
        child.send(message, (error) => {
          if (error) {
            if (root) owner?.markUnknown();
            reject(error);
          } else resolve();
        });
      if (root && owner) owner.runAdmitted(message, dispatch);
      else dispatch();
    } catch (error) {
      if (root) owner?.markUnknown();
      reject(error);
    }
  });
}

function observeChildTermination(child: PluginChild): ChildTermination {
  let resolveCompletion = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const state: ChildTermination = { closed: false, completion };
  child.on("close", () => {
    state.closed = true;
    resolveCompletion();
  });
  return state;
}
async function terminateObservedChild(
  child: PluginChild,
  termination: ChildTermination,
): Promise<void> {
  terminatePluginChild(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), SOFT_SHUTDOWN_TIMEOUT_MS);
  try {
    await termination.completion;
  } finally {
    clearTimeout(timer);
  }
}

function assertChildAlive(loaded: LoadedPlugin): void {
  if (loaded.termination?.closed)
    throw new Error(`Plugin process exited during activation: ${loaded.id}`);
}

export class PluginRuntime {
  private observationEpoch = 0;
  getObservationEpoch(): number {
    return this.observationEpoch;
  }

  private maintenanceIdentity: PluginMaintenanceIdentity | null = null;
  private maintenanceUncertain = false;
  /** HOLD by default until both executing daemon and child closure capabilities are integrated. */
  readonly maintenance: PluginMaintenancePort = {
    supportsV1: () => this.hasQualifiedCohort(),
    begin: (identity) => {
      // Runs synchronously, including restored holds before start/qualification/IPC awaits.
      if (
        this.maintenanceIdentity &&
        !samePluginMaintenanceIdentity(this.maintenanceIdentity, identity)
      ) {
        this.maintenanceUncertain = true;
        return Promise.resolve("unknown");
      }
      this.maintenanceIdentity = { ...identity };
      return this.holdQualifiedCohort(identity);
    },
    end: (identity) => this.releaseQualifiedCohort(identity),
  };

  private hasQualifiedCohort(): boolean {
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (!owner || !isQualifiedDaemonOwner(owner) || this.maintenanceUncertain) return false;
    try {
      owner.assertFresh();
      for (const loaded of this.plugins.values()) {
        if (loaded.builtinInstance) {
          assertQualifiedBuiltinInstance(loaded.child, owner, loaded.id);
          if (loaded.termination?.closed) return false;
          continue;
        }
        if (
          !loaded.qualifiedChild ||
          !loaded.activationTicket?.authorization.passiveProfile ||
          !loaded.loadedReceipt ||
          loaded.termination?.closed
        )
          return false;
        owner.assertOwnedExecutionHandle(
          loaded.qualifiedChild.child,
          "plugin-child",
          loaded.instanceId,
        );
        loaded.qualifiedChild.assertFresh();
      }
      return true;
    } catch {
      return false;
    }
  }

  private async childBarrier(
    loaded: LoadedPlugin,
    identity: PluginMaintenanceIdentity,
    type: "maintenance.begin" | "maintenance.end",
  ): Promise<string> {
    const response = await this.request(loaded, {
      type,
      requestId: randomUUID(),
      instanceId: loaded.instanceId,
      ...identity,
    });
    if (
      !response ||
      typeof response !== "object" ||
      Reflect.get(response, "generation") !== identity.generation ||
      Reflect.get(response, "transactionId") !== identity.transactionId ||
      Reflect.get(response, "instanceId") !== loaded.instanceId
    )
      throw new Error("Plugin barrier acknowledgement identity mismatch");
    const status = Reflect.get(response, "status");
    if (typeof status !== "string") throw new Error("Missing plugin barrier acknowledgement");
    return status;
  }

  private async holdQualifiedCohort(
    identity: PluginMaintenanceIdentity,
  ): Promise<"held" | "known-busy" | "unknown"> {
    const epoch = this.observationEpoch;
    // Close every child execution-side barrier even when qualification is absent.
    const replies = await Promise.allSettled(
      [...this.plugins.values()].map((loaded) =>
        this.childBarrier(loaded, identity, "maintenance.begin"),
      ),
    );
    try {
      await this.observeQualifiedExecutions();
      if (!this.hasQualifiedCohort() || epoch !== this.observationEpoch) return "unknown";
      let busy = false;
      for (const reply of replies) {
        if (reply.status !== "fulfilled") return "unknown";
        if (reply.value === "known-busy") busy = true;
        else if (reply.value !== "held") return "unknown";
      }
      for (const loaded of this.plugins.values()) if (loaded.executionOwner?.busy()) busy = true;
      return busy ? "known-busy" : "held";
    } catch {
      return "unknown";
    }
  }

  private async releaseQualifiedCohort(identity: PluginMaintenanceIdentity): Promise<void> {
    if (
      !this.maintenanceIdentity ||
      !samePluginMaintenanceIdentity(this.maintenanceIdentity, identity)
    )
      throw new Error("Plugin barrier release identity mismatch");
    await this.observeQualifiedExecutions();
    if (!this.hasQualifiedCohort())
      throw new Error("Plugin executing closure is not qualified for maintenance release");
    const epoch = this.observationEpoch;
    for (const loaded of this.plugins.values()) {
      if ((await this.childBarrier(loaded, identity, "maintenance.end")) !== "ended")
        throw new Error("Plugin barrier release uncertain");
    }
    await this.observeQualifiedExecutions();
    if (epoch !== this.observationEpoch || !this.hasQualifiedCohort())
      throw new Error("Plugin barrier release changed");
    this.maintenanceIdentity = null;
  }

  private requireLifecycleAdmission(
    held?: PluginHeldOperation,
    initialization?: QualifiedPluginInitialization,
    pluginId?: string,
    sourcePath?: string,
  ): void {
    if (held && initialization) throw new Error("Ambiguous plugin operation scope");
    if (initialization) {
      const owner = this.dependencies.qualifiedDaemonOwner;
      const native = this.dependencies.nativeMaintenance;
      if (!owner || !native || !pluginId || !sourcePath || this.maintenanceUncertain)
        throw new Error("Qualified initialization authority unavailable");
      assertQualifiedPluginInitialization(initialization, owner, native, pluginId, sourcePath);
      return;
    }
    if (held) {
      assertPluginHeldOperation(held, held.claim.pluginId, held.claim.path);
      if (
        !this.maintenanceIdentity ||
        !samePluginMaintenanceIdentity(this.maintenanceIdentity, held.claim) ||
        this.maintenanceUncertain
      )
        throw new Error("Held plugin lifecycle reservation mismatch");
      return;
    }
    if (this.maintenanceIdentity || this.maintenanceUncertain)
      throw new Error("Plugin maintenance admission is closed");
  }
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly activationGenerations = new Map<string, number>();
  private readonly pendingEvents = new Set<Promise<void>>();
  private readonly logTails = new Map<string, PluginLogTail>();
  private readonly logger: pino.Logger;
  private readonly spawnChild: () => PluginChild;
  private sessionHost: PluginPaseoSessionHost | null;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();
  private readonly sessionOpenListeners = new Set<() => void>();

  constructor(
    logger: pino.Logger,
    private readonly daemonVersion: string,
    private readonly dependencies: PluginRuntimeDependencies = {},
  ) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
    this.sessionHost = dependencies.sessionHost ?? null;
  }

  bindPaseoSessionHost(sessionHost: PluginPaseoSessionHost): void {
    if (this.plugins.size > 0)
      throw new Error("Cannot replace the plugin session host while running");
    this.sessionHost = sessionHost;
  }

  subscribe(listener: (pluginId: string, error?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessionOpenChanges(listener: () => void): () => void {
    this.sessionOpenListeners.add(listener);
    return () => this.sessionOpenListeners.delete(listener);
  }

  private notifySessionOpenChange(loaded: LoadedPlugin): void {
    if (!loaded.hooks.includes("agent.open.before")) return;
    for (const listener of this.sessionOpenListeners) listener();
  }

  async startPlugin(
    pluginId: string,
    configuredPath: string,
    canPublish: () => boolean = () => true,
    operation: ActivationOperation = "activate",
    held?: PluginHeldOperation,
    initialization?: QualifiedPluginInitialization,
  ): Promise<void> {
    this.requireLifecycleAdmission(held, initialization, pluginId, configuredPath);
    if (held) assertPluginHeldOperation(held, pluginId, configuredPath);
    if (this.plugins.has(pluginId)) throw new Error(`Plugin is already running: ${pluginId}`);
    this.appendLog(pluginId, "stdout", "[paseo] Loading plugin");
    const loaded = await this.loadDirectoryPlugin(
      pluginId,
      configuredPath,
      canPublish,
      operation,
      held,
      initialization,
    ).catch((error) => {
      this.appendLog(pluginId, "stderr", `[paseo] Plugin failed to load: ${describeError(error)}`);
      throw error;
    });
    if (!canPublish() || loaded.termination?.closed) {
      if (loaded.termination?.closed && loaded.loadedReceipt?.snapshotRoot)
        await this.dependencies.activationPolicy?.hold(pluginId);
      if (held) loaded.executionOwner?.expectHeldTermination(held, loaded.instanceId);
      await this.stopPlugin(loaded);
      throw new Error(`Plugin start cancelled: ${pluginId}`);
    }
    this.observationEpoch++;
    this.plugins.set(pluginId, loaded);
    this.notifySessionOpenChange(loaded);
    this.appendLog(pluginId, "stdout", "[paseo] Plugin ready");
  }

  async startBuiltinPlugin(
    input: { id: string; directory: string },
    initialization?: QualifiedPluginInitialization,
  ): Promise<void> {
    this.requireLifecycleAdmission(undefined, initialization, input.id, input.directory);
    if (this.plugins.has(input.id)) throw new Error(`Plugin is already running: ${input.id}`);
    this.appendLog(input.id, "stdout", "[paseo] Loading plugin");
    const directory = await realpath(path.resolve(input.directory));
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (owner && isQualifiedDaemonOwner(owner)) {
      await this.startRetainedBuiltin(input.id, directory, owner, initialization);
      return;
    }
    const ticket = await this.dependencies.activationPolicy?.authorize(input.id, directory);
    const bundles = await this.compileActivation(
      input.id,
      directory,
      ticket,
      undefined,
      initialization,
      input.id,
    );
    const { manifest } = bundles;
    if (!bundles.serverBundle) throw new Error(`Built-in plugin ${input.id} needs a server entry`);
    const loaded = ticket
      ? await this.launchPreparedPlugin({
          initialization,
          pluginId: input.id,
          configuredPath: directory,
          directory,
          ticket,
          operation: "activate",
          canPublish: () => {
            if (initialization)
              this.requireLifecycleAdmission(undefined, initialization, input.id, directory);
            return (
              !this.maintenanceUncertain &&
              (initialization !== undefined || this.maintenanceIdentity === null)
            );
          },
          requirements: manifest.requirements,
          serverBundle: bundles.serverBundle,
          clientBundle: bundles.clientBundle ?? "",
        })
      : await this.launchPlugin({
          pluginId: input.id,
          pluginDirectory: directory,
          requirements: manifest.requirements,
          child: new InternalPluginChild(evaluateBundle),
          bundle: bundles.serverBundle,
          clientBundle: bundles.clientBundle ?? "",
        });
    this.observationEpoch++;
    this.plugins.set(input.id, loaded);
    this.notifySessionOpenChange(loaded);
    this.appendLog(input.id, "stdout", "[paseo] Plugin ready");
  }

  private async startRetainedBuiltin(
    pluginId: string,
    directory: string,
    owner: QualifiedDaemonOwner,
    initialization?: QualifiedPluginInitialization,
  ): Promise<void> {
    if (!initialization) throw new Error("Retained builtin needs actual startup scope");
    this.requireLifecycleAdmission(undefined, initialization, pluginId, directory);
    if (directory !== path.join(owner.root, "builtin-plugins", pluginId))
      throw new Error("Builtin source differs from retained distribution");
    const retained = await createQualifiedBuiltinInstance(owner, pluginId);
    const observation = getQualifiedBuiltinObservation(retained.child, owner);
    const inherited = this.maintenanceIdentity;
    const barrier = inherited ?? { generation: 0, transactionId: `builtin-init:${randomUUID()}` };
    if (inherited) assertQualifiedBuiltinInstance(retained.child, owner, pluginId);
    const loaded = await this.launchPlugin({
      builtinInstance: { child: retained.child, directory },
      initializationBarrier: barrier,
      pluginId,
      pluginDirectory: directory,
      requirements: retained.manifest.requirements,
      child: retained.child,
      bundle: retained.serverBundle,
      clientBundle: "",
      beforeInitialize: async (dispatch) => {
        await owner.refresh();
        this.requireLifecycleAdmission(undefined, initialization, pluginId, directory);
        const current = getQualifiedBuiltinObservation(retained.child, owner);
        if (current.instanceId !== observation.instanceId)
          throw new Error("Builtin initialization instance changed");
        if (inherited) assertQualifiedBuiltinInstance(retained.child, owner, pluginId);
        dispatch();
      },
    });
    try {
      if ((await this.childBarrier(loaded, barrier, "maintenance.begin")) !== "held")
        throw new Error("Builtin initialization did not reach idle barrier");
      await owner.refresh();
      this.requireLifecycleAdmission(undefined, initialization, pluginId, directory);
      if (inherited) assertQualifiedBuiltinInstance(retained.child, owner, pluginId);
      else if ((await this.childBarrier(loaded, barrier, "maintenance.end")) !== "ended")
        throw new Error("Builtin initialization barrier release uncertain");
      assertChildAlive(loaded);
      this.observationEpoch++;
      this.plugins.set(pluginId, loaded);
      this.notifySessionOpenChange(loaded);
      this.appendLog(pluginId, "stdout", "[paseo] Plugin ready");
    } catch (error) {
      this.maintenanceUncertain = true;
      this.dependencies.nativeMaintenance?.holdForUnknownWork();
      await this.stopPlugin(loaded);
      throw error;
    }
  }

  async validateActivation(
    pluginId: string,
    directory: string,
    operation: ActivationOperation = "activate",
    held?: PluginHeldOperation,
  ): Promise<void> {
    const policy = this.dependencies.activationPolicy;
    const ticket = await policy?.authorize(pluginId, directory, operation);
    const bundles = await this.compileActivation(pluginId, directory, ticket, held);
    if (ticket && !bundles.serverBundle)
      throw new Error("Managed activation requires a server bundle");
    await policy?.authorize(
      pluginId,
      directory,
      operation,
      bundles.serverBundle ?? undefined,
      ticket,
    );
  }

  async tryValidateHeldActivation(
    pluginId: string,
    directory: string,
    operation: ActivationOperation,
    held: PluginHeldOperation,
  ) {
    this.requireLifecycleAdmission(held);
    assertPluginHeldOperation(held, pluginId, directory);
    const policy = this.dependencies.activationPolicy;
    const owner = this.dependencies.qualifiedDaemonOwner;
    const native = this.dependencies.nativeMaintenance;
    if (!policy || !owner || !isQualifiedDaemonOwner(owner) || !native)
      throw new Error("Held compiler authority unavailable");
    const ticket = await policy.authorize(pluginId, directory, operation);
    if (!ticket?.authorization.passiveProfile)
      throw new Error("Held candidate lacks protected passive profile");
    await owner.refresh();
    const incarnation = owner.binding.expectedIncarnation;
    if (typeof incarnation !== "string") throw new Error("Missing enclosing incarnation");
    owner.assertQualification(ticket.authorization.passiveProfile, incarnation);
    const attempt = await tryCompileQualifiedDirectoryPlugin(directory, this.daemonVersion, {
      owner,
      native,
      held,
      snapshotRoot: ticket.authorization.snapshotRoot,
    });
    await policy.authorize(
      pluginId,
      directory,
      operation,
      attempt.outcome === "compiled" ? (attempt.bundles.serverBundle ?? undefined) : undefined,
      ticket,
    );
    return { ticket, attempt };
  }

  /** Pure retained-instance observation; no helper, hook or provider work is dispatched. */
  observeBuiltinCohort(): Map<
    string,
    Extract<ManagedPluginCohortV2Entry, { kind: "builtin-in-process" }>
  > {
    const owner = this.dependencies.qualifiedDaemonOwner;
    if (!owner || !isQualifiedDaemonOwner(owner)) throw new Error("Builtin observer unavailable");
    owner.assertFresh();
    const result = new Map<
      string,
      Extract<ManagedPluginCohortV2Entry, { kind: "builtin-in-process" }>
    >();
    for (const [pluginId, loaded] of this.plugins) {
      if (!loaded.builtinInstance) continue;
      if (loaded.child !== loaded.builtinInstance.child || loaded.termination?.closed)
        throw new Error("Builtin observed identity closed or changed");
      const actual = getQualifiedBuiltinObservation(loaded.child, owner);
      if (actual.id !== pluginId || actual.instanceId !== loaded.instanceId)
        throw new Error("Builtin observed identity mismatch");
      const receipt = {
        kind: "builtin-in-process" as const,
        pluginId,
        instanceId: actual.instanceId,
        enclosingIncarnation: actual.enclosingIncarnation,
        sourcePath: loaded.builtinInstance.directory,
        sourceSha256: actual.sourceSha256,
        serverBundleSha256: actual.serverBundleSha256,
        moduleTableSha256: actual.moduleTableSha256,
        profileSha256: actual.profileSha256,
        closure: { ...actual.closure },
      };
      let execution: Extract<
        ManagedPluginCohortV2Entry,
        { kind: "builtin-in-process" }
      >["execution"] = null;
      try {
        assertQualifiedBuiltinInstance(loaded.child, owner, pluginId);
        if (actual.profileSha256)
          execution = {
            ...receipt,
            profileSha256: actual.profileSha256,
            contract: "builtin-in-process-v1",
            distributionBuildId: actual.distributionBuildId,
          };
      } catch {
        // Provenance is observable without a finite protected execution profile.
      }
      result.set(pluginId, {
        kind: "builtin-in-process",
        pluginId,
        registration: { path: loaded.builtinInstance.directory },
        enabled: true,
        loaded: receipt,
        execution,
      });
    }
    return result;
  }

  async observeQualifiedDirectoryExecutions(): Promise<Map<string, ManagedPluginCohortExecution>> {
    const owner = this.dependencies.qualifiedDaemonOwner;
    const policy = this.dependencies.activationPolicy;
    if (!owner || !isQualifiedDaemonOwner(owner) || !policy)
      throw new Error("Qualified runtime authority unavailable");
    const epoch = this.observationEpoch;
    await owner.refresh();
    const result = new Map<string, ManagedPluginCohortExecution>();
    for (const [id, loaded] of this.plugins)
      if (!loaded.builtinInstance)
        result.set(id, await this.observeQualifiedExecution(id, loaded, owner, policy));
    await owner.refresh();
    if (epoch !== this.observationEpoch) throw new Error("Plugin cohort changed");
    return result;
  }

  async observeQualifiedExecutions(): Promise<Map<string, ManagedPluginCohortExecution>> {
    const owner = this.dependencies.qualifiedDaemonOwner;
    const policy = this.dependencies.activationPolicy;
    if (!owner || !isQualifiedDaemonOwner(owner) || !policy)
      throw new Error("Qualified runtime authority unavailable");
    const epoch = this.observationEpoch;
    await owner.refresh();
    const result = new Map<string, ManagedPluginCohortExecution>();
    for (const [id, loaded] of this.plugins) {
      if (loaded.builtinInstance) {
        assertQualifiedBuiltinInstance(loaded.child, owner, id);
        if (loaded.termination?.closed) throw new Error("Builtin instance closed");
      } else result.set(id, await this.observeQualifiedExecution(id, loaded, owner, policy));
    }
    await owner.refresh();
    if (epoch !== this.observationEpoch) throw new Error("Plugin cohort changed");
    return result;
  }

  private async observeQualifiedExecution(
    id: string,
    loaded: LoadedPlugin,
    owner: QualifiedDaemonOwner,
    policy: ManagedPluginActivationPolicy,
  ): Promise<ManagedPluginCohortExecution> {
    const child = loaded.qualifiedChild;
    const ticket = loaded.activationTicket;
    const receipt = loaded.loadedReceipt;
    const profile = ticket?.authorization.passiveProfile;
    if (
      !child ||
      !ticket ||
      !receipt ||
      !profile ||
      loaded.child !== child.child ||
      loaded.termination?.closed
    )
      throw new Error("Unqualified or busy plugin in executing cohort");
    owner.assertOwnedExecutionHandle(child.child, "plugin-child", child.incarnation);
    child.assertFresh();
    if (receipt.processStartToken !== child.incarnation)
      throw new Error("Loaded execution identity mismatch");
    const observation = await child.challenge();
    if (observation.incarnation !== receipt.processStartToken || observation.pid !== receipt.pid)
      throw new Error("Fresh child observation mismatch");
    assertProfileClosure(profile, child);
    const before = await policy.observeLoadedQualification(id, receipt, ticket);
    const enclosingIncarnation = owner.binding.expectedIncarnation;
    if (typeof enclosingIncarnation !== "string" || !enclosingIncarnation)
      throw new Error("Missing enclosing execution incarnation");
    owner.assertQualification(child.closure, enclosingIncarnation);
    const after = await policy.observeLoadedQualification(id, receipt, ticket);
    if (before !== after || this.plugins.get(id) !== loaded || loaded.termination?.closed)
      throw new Error("Plugin execution changed during observation");
    return {
      contract: "native-passive-contract-1",
      incarnation: child.incarnation,
      distributionBuildId: observation.distributionBuildId,
      closure: { ...child.closure },
    };
  }

  private async compileActivation(
    pluginId: string,
    directory: string,
    ticket: ActivationTicket | undefined,
    held?: PluginHeldOperation,
    initialization?: QualifiedPluginInitialization,
    builtinId?: string,
  ) {
    if (!ticket?.authorization.passiveProfile) {
      if (held || initialization)
        throw new Error("Qualified plugin operations require protected passive qualification");
      return compileDirectoryPlugin(directory, this.daemonVersion, builtinId);
    }
    const owner = this.dependencies.qualifiedDaemonOwner;
    const native = this.dependencies.nativeMaintenance;
    if (!owner || !isQualifiedDaemonOwner(owner) || !native || (!held && !initialization))
      throw new Error("Qualified activation requires an authenticated native operation");
    this.requireLifecycleAdmission(held, initialization, pluginId, directory);
    await owner.refresh();
    const incarnation = owner.binding.expectedIncarnation;
    if (typeof incarnation !== "string") throw new Error("Missing qualified daemon incarnation");
    owner.assertQualification(ticket.authorization.passiveProfile, incarnation);
    if (initialization)
      return compileQualifiedInitialDirectoryPlugin(
        directory,
        this.daemonVersion,
        {
          owner,
          native,
          initialization,
          pluginId,
          sourcePath: directory,
          snapshotRoot: ticket.authorization.snapshotRoot,
        },
        ticket.authorization,
        builtinId,
      );
    return compileQualifiedDirectoryPlugin(directory, this.daemonVersion, {
      owner,
      native,
      held: held!,
      snapshotRoot: ticket.authorization.snapshotRoot,
    });
  }

  getLoadedReceipt(pluginId: string): PluginLoadedReceipt | undefined {
    return this.plugins.get(pluginId)?.loadedReceipt;
  }

  async validatePlugin(configuredPath: string): Promise<void> {
    await compileDirectoryPlugin(path.resolve(configuredPath), this.daemonVersion);
  }

  async stopPluginById(pluginId: string, held?: PluginHeldOperation): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return false;
    if (held) {
      this.requireLifecycleAdmission(held);
      const source = loaded.loadedReceipt?.sourcePath;
      if (
        held.claim.pluginId !== pluginId ||
        (source !== held.claim.expectedPath && source !== held.claim.path)
      )
        throw new Error("Held stop source identity mismatch");
      loaded.executionOwner?.expectHeldTermination(held, loaded.instanceId);
    }
    this.observationEpoch++;
    this.plugins.delete(pluginId);
    this.notifySessionOpenChange(loaded);
    this.rejectPending(loaded, `Plugin stopped: ${pluginId}`);
    await this.stopPlugin(loaded);
    return true;
  }

  catalog(): Array<{
    id: string;
    clientBundle: string;
    clientBundleHash: string;
    requirements?: PluginRequirements;
  }> {
    return [...this.plugins.values()]
      .map(({ id, clientBundle, clientBundleHash, requirements }) => ({
        id,
        clientBundle,
        clientBundleHash,
        requirements,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getProviderRegistrations(pluginId: string): readonly PluginProviderMetadata[] {
    return this.plugins.get(pluginId)?.providers ?? [];
  }

  getUsageSourceRegistrations(pluginId: string): readonly PluginUsageSourceMetadata[] {
    return this.plugins.get(pluginId)?.usageSources ?? [];
  }

  fetchUsage(pluginId: string, sourceId: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return this.request(loaded, { type: "usage.fetch", requestId: randomUUID(), sourceId, input });
  }

  discoverUsage(pluginId: string, sourceId: string, scope: UsageScope): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return this.request(loaded, {
      type: "usage.discover",
      requestId: randomUUID(),
      sourceId,
      scope,
    });
  }

  async getProviderStatus(
    pluginId: string,
    providerId: string,
    request: ProviderStatusRequest,
  ): Promise<ProviderStatus> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    return ProviderStatusSchema.parse(
      await this.request(loaded, {
        type: "provider.status",
        requestId: randomUUID(),
        providerId,
        request,
      }),
    );
  }

  async connectProvider(
    pluginId: string,
    providerId: string,
    request: ProviderConnectRequest,
  ): Promise<ProviderConnection> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded?.child) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.providers.some((provider) => provider.id === providerId)) {
      throw new Error(`Plugin ${pluginId} does not contribute provider ${providerId}`);
    }
    const connectionId = randomUUID();
    let resolveConnected!: (connection: ProviderConnection) => void;
    let rejectConnected!: (error: Error) => void;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const connected = new Promise<ProviderConnection>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void closed.catch(() => undefined);
    const state: RemoteProviderConnection = {
      request,
      capabilities: [],
      listeners: new Set(),
      pendingSends: new Map(),
      sessions: new Map(),
      connected: false,
      closed: false,
      closedPromise: closed,
      resolveConnected,
      rejectConnected,
      resolveClosed,
      rejectClosed,
    };
    loaded.providerConnections.set(connectionId, state);
    const timeout = setTimeout(() => {
      if (state.connected) return;
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider connection timed out: ${pluginId}.${providerId}`),
      );
    }, REQUEST_TIMEOUT_MS);
    void send(loaded.child, {
      type: "provider.connect",
      providerId,
      connectionId,
      request,
    }).catch((error) => {
      clearTimeout(timeout);
      this.abandonProviderConnect(loaded, connectionId, state, error);
    });
    return connected.finally(() => clearTimeout(timeout));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return (
      this.logTails.get(pluginId)?.entries.map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        stream: entry.stream,
        message: entry.message,
      })) ?? []
    );
  }

  clearLogs(pluginId: string): void {
    this.logTails.delete(pluginId);
  }

  async invoke(pluginId: string, method: string, input: unknown): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.methods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute RPC ${method}`);
    return this.request(loaded, { type: "invoke", requestId: randomUUID(), method, input });
  }

  /** Starts one subscriber's handler in the plugin process. */
  startSubscription(pluginId: string, method: string, input: unknown): PluginRuntimeSubscription {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if (!loaded.subscriptionMethods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute subscription ${method}`);
    const subscriptionId = randomUUID();
    const subscription = new BufferedPluginSubscription();
    loaded.subscriptions.set(subscriptionId, subscription);
    const ready = this.request(loaded, {
      type: "subscribe",
      requestId: randomUUID(),
      subscriptionId,
      method,
      input,
    }).then(
      () => undefined,
      (error: unknown) => {
        loaded.subscriptions.delete(subscriptionId);
        throw error;
      },
    );
    return {
      ready,
      attach: (sink) => subscription.attach(sink),
      release: () => {
        subscription.released();
        if (!loaded.subscriptions.delete(subscriptionId)) return;
        if (loaded.child?.connected)
          void send(loaded.child, { type: "unsubscribe", subscriptionId }).catch(() => undefined);
      },
    };
  }

  emit<Name extends keyof PluginHookEvents>(name: Name, event: PluginHookEvents[Name]): void {
    for (const loaded of this.plugins.values()) {
      if (!loaded.hooks.includes(name)) {
        continue;
      }
      const request = this.request(loaded, {
        type: "hook",
        requestId: randomUUID(),
        name,
        input: event,
      })
        .then(() => undefined)
        .catch((error) => {
          this.appendLog(
            loaded.id,
            "stderr",
            `Lifecycle hook ${name} failed: ${describeError(error)}`,
          );
        });
      this.pendingEvents.add(request);
      void request.finally(() => this.pendingEvents.delete(request));
    }
  }

  async drainEvents(): Promise<void> {
    await Promise.all(this.pendingEvents);
  }

  async wait(
    name: "worktree.create.after",
    payload: PluginHookPayload<"worktree.create.after">,
  ): Promise<void> {
    const plugins = [...this.plugins.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const loaded of plugins) {
      if (!loaded.hooks.includes(name)) continue;
      try {
        await this.request(loaded, { type: "hook", requestId: randomUUID(), name, input: payload });
      } catch (error) {
        throw new Error(`Plugin ${loaded.id} ${name} failed: ${describeError(error)}`, {
          cause: error,
        });
      }
    }
  }

  async before<Name extends keyof PluginWireBeforeRequests>(
    name: Name,
    input: PluginWireBeforeRequests[Name],
  ): Promise<PluginBeforeResults[Name]> {
    let request = validateBeforeRequest(name, input);
    const plugins = [...this.plugins.values()].sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
    const attached: AttachedAgentTool[] = [];
    const mcpServers: SessionOpenWireRequest["mcpServers"] = {};
    const mcpServerOwners: Record<string, string> = {};
    for (const loaded of plugins) {
      if (!loaded.hooks.includes(name)) {
        continue;
      }
      try {
        const output = await this.request(loaded, {
          type: "hook",
          requestId: randomUUID(),
          name,
          input: name === "agent.open.before" ? { ...request, tools: [], mcpServers: {} } : request,
        });
        request = await validateBeforeResult(name, request, output);
        if (name === "worktree.create.before") {
          const worktree = request as PluginWireBeforeRequests["worktree.create.before"];
          worktree.path = await validateWorktreePath({
            candidate: worktree.path,
            repoPath: worktree.repoRoot,
          });
        }
        if (name === "agent.open.before") {
          const opened = request as SessionOpenWireRequest;
          this.collectMcpServers(mcpServers, mcpServerOwners, loaded, opened.mcpServers);
          this.collectAgentTools(attached, loaded, opened.tools);
        }
      } catch (error) {
        if (name === "agent.open.before")
          this.detachTools((request as SessionOpenWireRequest).agentId);
        throw new Error(`Plugin ${loaded.id} ${name} failed: ${describeError(error)}`, {
          cause: error,
        });
      }
    }
    if (name === "agent.open.before") {
      return {
        ...request,
        tools: attached,
        mcpServers,
        mcpServerOwners,
      } as PluginBeforeResults[Name];
    }
    return request;
  }

  async getProviderCatalogCacheKey(
    pluginId: string,
    providerId: string,
    options: ProviderCatalogOptions,
  ): Promise<string | undefined> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    const output = await this.request(loaded, {
      type: "provider.catalog_key",
      requestId: randomUUID(),
      providerId,
      options,
    });
    if (output !== undefined && typeof output !== "string")
      throw new Error("Invalid catalogue key from plugin");
    return output;
  }

  private collectMcpServers(
    servers: SessionOpenWireRequest["mcpServers"],
    owners: Record<string, string>,
    loaded: LoadedPlugin,
    contributions: SessionOpenWireRequest["mcpServers"],
  ): void {
    for (const [name, server] of Object.entries(contributions)) {
      if (Object.hasOwn(servers, name)) {
        throw new Error(
          `MCP server ${name} from plugin ${loaded.id} collides with plugin ${owners[name]}`,
        );
      }
      servers[name] = server;
      owners[name] = loaded.id;
    }
  }

  private collectAgentTools(
    attached: AttachedAgentTool[],
    loaded: LoadedPlugin,
    tools: SessionOpenWireRequest["tools"],
  ): void {
    for (const tool of tools) {
      const collision = attached.find((entry) => entry.name === tool.name);
      if (collision)
        throw new Error(
          `Agent tool ${tool.name} from plugin ${loaded.id} collides with plugin ${collision.pluginId}`,
        );
      attached.push({ ...tool, pluginId: loaded.id, pluginInstanceId: loaded.instanceId });
    }
  }

  isToolPluginAvailable(pluginId: string, pluginInstanceId: string): boolean {
    return this.plugins.get(pluginId)?.instanceId === pluginInstanceId;
  }

  detachTools(agentId: string): void {
    for (const loaded of this.plugins.values()) {
      if (loaded.child) void send(loaded.child, { type: "tools.detach", agentId }).catch(() => {});
    }
  }

  async callTool(
    pluginId: string,
    pluginInstanceId: string,
    agent: PluginHookAgent,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded || loaded.instanceId !== pluginInstanceId)
      return { isError: true, text: `Plugin is not available: ${pluginId}` };
    const requestId = randomUUID();
    try {
      return (await this.request(
        loaded,
        { type: "tool.call", requestId, agent, name, input },
        signal,
      )) as AgentToolResult;
    } catch (error) {
      if (signal?.aborted) throw error;
      return { isError: true, text: describeError(error) };
    }
  }

  private request(
    loaded: LoadedPlugin,
    message: Extract<PluginProcessRequest, { requestId: string }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = loaded.child;
    const pluginId = loaded.id;
    if (!child) throw new Error(`Plugin ${pluginId} has no server entry`);
    const requestId = message.requestId;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timeout);
        loaded.pending.delete(requestId);
        if (message.type === "tool.call")
          void send(child, { type: "tool.cancel", requestId }).catch(() => {});
        signal?.removeEventListener("abort", cancel);
        reject(signal?.reason ?? new Error("Tool call canceled"));
      };
      const timeout = setTimeout(
        () => {
          loaded.pending.delete(requestId);
          signal?.removeEventListener("abort", cancel);
          if (message.type === "tool.call")
            void send(child, { type: "tool.cancel", requestId }).catch(() => {});
          if (message.type === "hook") {
            void send(child, { type: "hook.cancel", requestId }).catch(() => {});
          }
          // The handler may still start after the daemon gave up on it.
          if (message.type === "subscribe") {
            const { subscriptionId } = message;
            void send(child, { type: "unsubscribe", subscriptionId }).catch(() => {});
          }
          reject(new Error(`Plugin RPC timed out: ${pluginId}.${message.type}`));
        },
        message.type === "tool.call" ? TOOL_CALL_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      loaded.pending.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener("abort", cancel);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", cancel);
          reject(error);
        },
        timeout,
      });
      void send(child, message).catch((error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        loaded.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async stopAll(): Promise<void> {
    this.observationEpoch++;
    const loaded = [...this.plugins.values()];
    this.plugins.clear();
    for (const plugin of loaded) {
      this.notifySessionOpenChange(plugin);
      this.rejectPending(plugin, `Plugin stopped: ${plugin.id}`);
    }
    const results = await Promise.allSettled(loaded.map((plugin) => this.stopPlugin(plugin)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async loadDirectoryPlugin(
    pluginId: string,
    configuredPath: string,
    canPublish: () => boolean,
    operation: ActivationOperation,
    held?: PluginHeldOperation,
    initialization?: QualifiedPluginInitialization,
  ): Promise<LoadedPlugin> {
    const directory = await realpath(path.resolve(configuredPath));
    const policy = this.dependencies.activationPolicy;
    const ticket = await policy?.authorize(pluginId, configuredPath, operation);
    const bundles = await this.compileActivation(pluginId, directory, ticket, held, initialization);
    const { manifest } = bundles;
    if (!canPublish()) throw new Error(`Plugin start cancelled: ${pluginId}`);
    const serverBundle = bundles.serverBundle;
    const compilation = { pluginId, configuredPath, directory, operation, ticket, bundles };
    if (!serverBundle) return this.loadClientOnlyPlugin(compilation);
    return this.launchPreparedPlugin({
      held,
      initialization,
      canPublish,
      pluginId,
      configuredPath,
      directory,
      operation,
      ticket,
      serverBundle,
      clientBundle: bundles.clientBundle ?? "",
      requirements: manifest.requirements,
    });
  }

  private async loadClientOnlyPlugin(input: DirectoryCompilation): Promise<LoadedPlugin> {
    const { pluginId, configuredPath, operation, ticket, bundles } = input;
    const { manifest } = bundles;
    const policy = this.dependencies.activationPolicy;
    const currentTicket = await policy?.authorize(
      pluginId,
      configuredPath,
      operation,
      undefined,
      ticket,
    );
    if (currentTicket) throw new Error("Managed activation requires a server bundle");
    if (ticket) throw new Error("Managed activation requires a server bundle");
    const clientBundle = bundles.clientBundle ?? "";
    return {
      id: pluginId,
      instanceId: randomUUID(),
      clientBundle,
      clientBundleHash: hashClientBundle(clientBundle),
      requirements: manifest.requirements,
      methods: new Set(),
      subscriptionMethods: new Set(),
      subscriptions: new Map(),
      hooks: [],
      providers: [],
      usageSources: [],
      child: null,
      outputCapture: null,
      pending: new Map(),
      providerConnections: new Map(),
      providerConnectionTombstones: new Set(),
      sessionSocket: null,
      sessionClosed: null,
    };
  }

  private async launchPreparedPlugin(input: ServerPluginActivation): Promise<LoadedPlugin> {
    const { pluginId, directory, ticket, serverBundle, clientBundle, requirements } = input;
    const policy = this.dependencies.activationPolicy;
    await this.assertPreparedAuthorization(input, "Managed enrollment changed during compilation");
    await policy?.arm(pluginId, ticket);
    try {
      await this.assertPreparedAuthorization(
        input,
        "Managed authorization changed before child launch",
      );
    } catch (error) {
      await policy?.finish(pluginId, ticket, false);
      throw error;
    }
    const startedAt = new Date().toISOString();
    let launched: LoadedPlugin | undefined;
    try {
      const owned = await this.prepareOwnedChild(input);
      const inheritedHold = this.maintenanceIdentity;
      const barrier =
        inheritedHold ??
        (input.initialization ? { generation: 0, transactionId: randomUUID() } : null);
      const loaded = await this.launchPlugin({
        initializationBarrier: barrier ?? undefined,
        qualifiedChild: owned,
        activationTicket: ticket,
        pluginId,
        pluginDirectory: directory,
        managedSource: ticket !== undefined,
        requirements,
        child:
          owned?.child ??
          (ticket && !this.dependencies.spawnChild ? spawnPluginChild({}) : this.spawnChild()),
        bundle: serverBundle,
        clientBundle,
        beforeInitialize: async (dispatch) => {
          if (owned) {
            const owner = this.dependencies.qualifiedDaemonOwner;
            if (!owner) throw new Error("Qualified initialize authority missing");
            await owner.refresh();
            owner.assertOwnedExecutionHandle(owned.child, "plugin-child", owned.incarnation);
            owned.assertFresh();
            this.requireLifecycleAdmission(input.held, input.initialization, pluginId, directory);
          }
          if (policy)
            await policy.dispatchAuthorized({
              id: pluginId,
              ticket,
              canPublish: input.canPublish,
              dispatch,
            });
          else {
            if (!input.canPublish()) throw new Error(`Plugin start cancelled: ${pluginId}`);
            dispatch();
          }
        },
      });
      launched = loaded;
      if (owned) await this.verifySuccessorBarrier(input, loaded, owned, barrier, inheritedHold);
      assertChildAlive(loaded);
      await this.assertPreparedAuthorization(input, "Managed enrollment changed during launch");
      assertChildAlive(loaded);
      await this.recordDirectoryReceipt(input, loaded, startedAt);
      assertChildAlive(loaded);
      return loaded;
    } catch (error) {
      if (launched) {
        if (input.held)
          launched.executionOwner?.expectHeldTermination(input.held, launched.instanceId);
        await this.stopPlugin(launched);
      }
      await policy?.finish(pluginId, ticket, false);
      throw error;
    }
  }

  private async verifySuccessorBarrier(
    input: ServerPluginActivation,
    loaded: LoadedPlugin,
    owned: QualifiedOwnedChild,
    barrier: PluginMaintenanceIdentity | null,
    inheritedHold: PluginMaintenanceIdentity | null,
  ): Promise<void> {
    if (
      !barrier ||
      this.maintenanceIdentity !== inheritedHold ||
      (await this.childBarrier(loaded, barrier, "maintenance.begin")) !== "held"
    )
      throw new Error("Qualified successor did not acknowledge its inherited barrier");
    owned.assertFresh();
    if (
      input.initialization &&
      !inheritedHold &&
      (await this.childBarrier(loaded, barrier, "maintenance.end")) !== "ended"
    )
      throw new Error("Initialization barrier release uncertain");
  }

  private async prepareOwnedChild(
    input: ServerPluginActivation,
  ): Promise<QualifiedOwnedChild | undefined> {
    const profile = input.ticket?.authorization.passiveProfile;
    if (!profile) return undefined;
    const owner = this.dependencies.qualifiedDaemonOwner;
    if ((!input.held && !input.initialization) || !owner || !isQualifiedDaemonOwner(owner))
      throw new Error("Qualified child owner unavailable");
    this.requireLifecycleAdmission(
      input.held,
      input.initialization,
      input.pluginId,
      input.directory,
    );
    await owner.refresh();
    const incarnation = owner.binding.expectedIncarnation;
    if (typeof incarnation !== "string") throw new Error("Missing qualified daemon incarnation");
    owner.assertQualification(profile, incarnation);
    const child = await owner.launchPluginChild();
    try {
      owner.assertOwnedExecutionHandle(child.child, "plugin-child", child.incarnation);
      child.assertFresh();
      assertProfileClosure(profile, child);
      return child;
    } catch (error) {
      const termination = observeChildTermination(child.child);
      await terminateObservedChild(child.child, termination);
      throw error;
    }
  }

  private async assertPreparedAuthorization(
    input: ServerPluginActivation,
    message: string,
  ): Promise<void> {
    const { pluginId, configuredPath, operation, serverBundle, ticket } = input;
    const currentTicket = await this.dependencies.activationPolicy?.authorize(
      pluginId,
      configuredPath,
      operation,
      serverBundle,
      ticket,
    );
    if (JSON.stringify(currentTicket) !== JSON.stringify(ticket)) throw new Error(message);
    if (input.held) assertPluginHeldOperation(input.held, pluginId, input.directory);
  }

  private async recordDirectoryReceipt(
    input: ServerPluginActivation,
    loaded: LoadedPlugin,
    startedAt: string,
  ): Promise<void> {
    const { pluginId, ticket, directory, serverBundle } = input;
    const policy = this.dependencies.activationPolicy;
    loaded.loadedReceipt = {
      pluginId,
      activationGeneration:
        ticket?.generation ?? (this.activationGenerations.get(pluginId) ?? 0) + 1,
      sourcePath: directory,
      serverBundleSha256: createHash("sha256").update(serverBundle).digest("hex"),
      processStartToken: loaded.instanceId,
      startedAt,
      ...(loaded.child?.pid ? { pid: loaded.child.pid } : {}),
      ...(ticket
        ? {
            snapshotRoot: ticket.authorization.snapshotRoot,
            snapshotSha256: ticket.authorization.snapshotSha256,
          }
        : {}),
    };
    this.activationGenerations.set(pluginId, loaded.loadedReceipt.activationGeneration);
    assertChildAlive(loaded);
    await policy?.recordLoaded(pluginId, ticket, loaded.loadedReceipt);
    assertChildAlive(loaded);
    await policy?.finish(pluginId, ticket, true);
    assertChildAlive(loaded);
  }

  private async launchPlugin(input: {
    qualifiedChild?: QualifiedOwnedChild;
    builtinInstance?: { child: InternalPluginChild; directory: string };
    initializationBarrier?: PluginMaintenanceIdentity;
    activationTicket?: ActivationTicket;
    pluginId: string;
    pluginDirectory: string;
    managedSource?: boolean;
    requirements: PluginRequirements | undefined;
    child: PluginChild;
    bundle: string;
    clientBundle: string;
    beforeInitialize?: (dispatch: () => void) => Promise<void>;
  }): Promise<LoadedPlugin> {
    const { pluginId, requirements, child, bundle, clientBundle } = input;
    this.observationEpoch++;
    const termination = observeChildTermination(child);
    const instanceId = input.builtinInstance
      ? getQualifiedBuiltinObservation(
          input.builtinInstance.child,
          this.dependencies.qualifiedDaemonOwner,
        ).instanceId
      : (input.qualifiedChild?.incarnation ?? randomUUID());
    const executionOwner = new PluginExecutionOwner(
      instanceId,
      this.dependencies.nativeMaintenance,
      () => this.maintenanceIdentity !== null || this.maintenanceUncertain,
      () => {
        if (this.dependencies.nativeMaintenance) this.maintenanceUncertain = true;
      },
      () => {
        this.observationEpoch++;
      },
    );
    childExecutionOwners.set(child, executionOwner);
    child.on("close", () => {
      this.observationEpoch++;
      executionOwner.terminated();
    });
    const sessionHost = this.sessionHost;
    if (!sessionHost) {
      await terminateObservedChild(child, termination);
      throw new Error("Plugin Paseo session host is not attached");
    }
    const outputCapture = new PluginOutputCapture(child, (stream, message) => {
      this.appendLog(pluginId, stream, message);
    });
    const session: PluginSessionBinding = {
      socket: new PluginSessionSocket(child),
      reattaching: false,
      plugin: null,
    };
    const pending = new Map<string, PendingInvocation>();
    const sessionAttachment = await sessionHost
      .attachPluginSocket(pluginId, session.socket)
      .catch(async (error) => {
        await terminateObservedChild(child, termination);
        throw error;
      });
    let loaded: LoadedPlugin | null = null;
    let ready: Extract<PluginProcessMessage, { type: "ready" }>;
    try {
      ready = await new Promise<Extract<PluginProcessMessage, { type: "ready" }>>(
        (resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(
            () => fail(new Error(`Plugin ${pluginId} did not initialize`)),
            REQUEST_TIMEOUT_MS,
          );
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          };
          child.on("message", (rawMessage) => {
            if (input.qualifiedChild?.consumeObservation(rawMessage)) return;
            const parsed = PluginProcessMessageSchema.safeParse(rawMessage);
            if (!parsed.success) {
              const error = new Error(
                `Plugin ${pluginId} sent an invalid message: ${parsed.error.message}`,
              );
              if (loaded) this.handleMalformedChildMessage(loaded, rawMessage, error);
              else fail(error);
              return;
            }
            const message = parsed.data;
            if (message.type === "execution.unknown") {
              executionOwner.markUnknown();
            } else if (message.type === "execution.settled") {
              executionOwner.settled(message.instanceId, message.requestKey);
            } else if (message.type === "paseo_frame") {
              this.routePluginFrame({
                session,
                pluginId,
                child,
                sessionHost,
                frame: message.data,
                isBinary: message.isBinary,
              });
            } else if (message.type === "paseo_close") {
              session.socket.peerClosed();
            } else if (message.type === "ready") {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(message);
            } else if (message.type === "fatal") {
              fail(new Error(message.error));
            } else if (loaded) {
              this.handleChildMessage(loaded, message);
            }
          });
          child.on("close", () => {
            session.socket.peerClosed();
            if (!loaded) {
              fail(new Error(`Plugin ${pluginId} exited during initialization`));
              return;
            }
            void this.handleChildClose(loaded);
          });
          const initialize = () => {
            if (termination.closed) {
              fail(new Error(`Plugin ${pluginId} exited before initialize`));
              return;
            }
            void send(child, {
              type: "initialize",
              pluginId,
              pluginDirectory: input.pluginDirectory,
              managedSource: input.managedSource === true,
              hostInstanceId: instanceId,
              ...((input.qualifiedChild || input.builtinInstance) && input.initializationBarrier
                ? {
                    passiveInitialization: {
                      contract: "native-passive-contract-1" as const,
                      hold: { ...input.initializationBarrier, instanceId },
                    },
                  }
                : {}),
              appVersion: this.daemonVersion,
              bundle,
              settingsDirectory: this.dependencies.settingsDirectory
                ? path.join(this.dependencies.settingsDirectory, pluginId)
                : undefined,
            }).catch(fail);
          };
          if (input.beforeInitialize) void input.beforeInitialize(initialize).catch(fail);
          else initialize();
        },
      );
    } catch (error) {
      session.socket.close();
      await sessionAttachment.closed;
      await terminateObservedChild(child, termination);
      throw error;
    }
    loaded = {
      id: pluginId,
      instanceId,
      qualifiedChild: input.qualifiedChild,
      builtinInstance: input.builtinInstance,
      activationTicket: input.activationTicket,
      executionOwner,
      clientBundle,
      clientBundleHash: hashClientBundle(clientBundle),
      requirements,
      termination,
      methods: new Set(ready.methods),
      subscriptionMethods: new Set(ready.subscriptions ?? []),
      subscriptions: new Map(),
      hooks: ready.hooks ?? [],
      providers: ready.providers ?? [],
      usageSources: ready.usageSources ?? [],
      child,
      outputCapture,
      pending,
      providerConnections: new Map(),
      providerConnectionTombstones: new Set(),
      sessionSocket: session.socket,
      sessionClosed: sessionAttachment.closed,
    };
    session.plugin = loaded;
    this.logger.info(
      { pluginId, methods: ready.methods, providers: ready.providers },
      "Loaded plugin",
    );
    return loaded;
  }

  /**
   * Frames still in flight belong to the closed session; only a fresh hello
   * means the child redialled and wants a new one. Attaching on the close
   * instead would leave a socket nobody speaks to until the host's hello
   * timeout closed it, and that close would attach another.
   */
  private routePluginFrame(input: PluginFrameInput): void {
    const { session, frame, isBinary } = input;
    if (session.socket.readyState === 1) {
      session.socket.receive(frame, isBinary);
      return;
    }
    if (session.reattaching || !isSessionHelloFrame({ frame, isBinary })) return;
    if (!this.canReattachPluginSession(input)) return;
    session.reattaching = true;
    void this.reattachPluginSession(input).finally(() => {
      session.reattaching = false;
    });
  }

  private async reattachPluginSession(input: PluginFrameInput): Promise<void> {
    const { session, pluginId, sessionHost, child, frame, isBinary } = input;
    const replacement = new PluginSessionSocket(child);
    try {
      const attachment = await sessionHost.attachPluginSocket(pluginId, replacement);
      if (!this.canReattachPluginSession(input)) {
        replacement.close();
        return;
      }
      session.socket = replacement;
      if (session.plugin) {
        session.plugin.sessionSocket = replacement;
        session.plugin.sessionClosed = attachment.closed;
      }
      replacement.receive(frame, isBinary);
      this.appendLog(pluginId, "stdout", "[paseo] Re-attached plugin session");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.appendLog(pluginId, "stderr", `[paseo] Failed to re-attach plugin session: ${reason}`);
      this.logger.warn({ pluginId, err: error }, "Failed to re-attach a plugin session");
      this.notify(pluginId, `Plugin session could not be re-attached: ${pluginId}`);
    }
  }

  /**
   * A published plugin whose process is still up. Anything else is either still
   * loading or being torn down, and must not get a new session.
   */
  private canReattachPluginSession(input: {
    session: PluginSessionBinding;
    pluginId: string;
    child: PluginChild;
  }): boolean {
    const { session, pluginId, child } = input;
    return (
      session.plugin !== null && this.plugins.get(pluginId) === session.plugin && child.connected
    );
  }

  private handleChildMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (message.type === "execution.settled") {
      loaded.executionOwner?.settled(message.instanceId, message.requestKey);
      return;
    }
    if (message.type === "execution.unknown") {
      loaded.executionOwner?.markUnknown();
      return;
    }
    if (message.type === "hooks.changed") {
      const hadSessionOpen = loaded.hooks.includes("agent.open.before");
      loaded.hooks = message.hooks;
      if (
        this.plugins.get(loaded.id) === loaded &&
        hadSessionOpen !== loaded.hooks.includes("agent.open.before")
      ) {
        for (const listener of this.sessionOpenListeners) listener();
      }
      return;
    }
    if (message.type === "settings.changed") {
      this.dependencies.onSettingsChanged?.(loaded.id, message.settingsId);
      return;
    }
    if (message.type.startsWith("provider.")) {
      this.handleProviderMessage(loaded, message);
      return;
    }
    if (message.type === "subscription.event") {
      loaded.subscriptions.get(message.subscriptionId)?.event(message.event);
      return;
    }
    if (message.type === "subscription.closed") {
      const subscription = loaded.subscriptions.get(message.subscriptionId);
      loaded.subscriptions.delete(message.subscriptionId);
      subscription?.closed(message.error);
      return;
    }
    if (message.type !== "result" && message.type !== "error") return;
    const pending = loaded.pending.get(message.requestId);
    if (!pending) return;
    loaded.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.type === "result") pending.resolve(message.output);
    else pending.reject(new Error(message.error));
  }

  private handleProviderMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if (!("connectionId" in message)) return;
    const state = loaded.providerConnections.get(message.connectionId);
    if (!state) {
      if (!loaded.providerConnectionTombstones.has(message.connectionId)) return;
      if (message.type === "provider.connected" && loaded.child?.connected) {
        void send(loaded.child, {
          type: "provider.close",
          connectionId: message.connectionId,
        }).catch(() => undefined);
      }
      if (message.type === "provider.closed" || message.type === "provider.connect_failed") {
        loaded.providerConnectionTombstones.delete(message.connectionId);
      }
      return;
    }
    if (message.type === "provider.connected") {
      this.finishProviderConnect(loaded, message.connectionId, state, message);
      return;
    }
    if (message.type === "provider.connect_failed") {
      this.abandonProviderConnect(loaded, message.connectionId, state, new Error(message.error));
      return;
    }
    if (message.type === "provider.accepted" || message.type === "provider.rejected") {
      const pending = state.pendingSends.get(message.acceptanceId);
      if (!pending) return;
      state.pendingSends.delete(message.acceptanceId);
      if (message.type === "provider.accepted") {
        this.trackAcceptedProviderInput(state, pending.input);
        pending.resolve();
      } else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "provider.event") {
      this.publishProviderEvent(loaded, message.connectionId, state, message.event);
      return;
    }
    if (message.type === "provider.closed") {
      loaded.providerConnections.delete(message.connectionId);
      if (message.error) {
        this.failRemoteProviderConnection(state, new Error(message.error));
        return;
      }
      state.closed = true;
      this.rejectProviderSends(state, "Provider connection closed");
      state.resolveClosed();
    }
  }

  private finishProviderConnect(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    message: Extract<PluginProcessMessage, { type: "provider.connected" }>,
  ): void {
    if (!Number.isInteger(message.version) || message.version < 1) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected invalid version: ${message.version}`),
      );
      return;
    }
    if (!state.request.versions.includes(message.version)) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected an unoffered version: ${message.version}`),
      );
      return;
    }
    const knownCapabilities = new Set<string>(PROVIDER_CAPABILITIES);
    const invalidCapability = message.capabilities.find(
      (capability) =>
        knownCapabilities.has(capability) && !state.request.capabilities.includes(capability),
    );
    if (invalidCapability) {
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin provider selected an unoffered capability: ${invalidCapability}`),
      );
      return;
    }
    const capabilities = PROVIDER_CAPABILITIES.filter((capability) =>
      message.capabilities.includes(capability),
    );
    const connection: ProviderConnection = {
      version: message.version,
      capabilities,
      send: (input) => this.sendProviderInput(loaded, connectionId, state, input),
      onEvent(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      close: () => this.closeProviderConnection(loaded, connectionId, state),
    };
    state.capabilities = capabilities;
    state.connected = true;
    state.resolveConnected(connection);
  }

  private abandonProviderConnect(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    error: Error,
  ): void {
    if (state.connected || state.closed) return;
    loaded.providerConnections.delete(connectionId);
    loaded.providerConnectionTombstones.add(connectionId);
    state.closed = true;
    state.rejectConnected(error);
    state.rejectClosed(error);
    if (loaded.child?.connected) {
      void send(loaded.child, { type: "provider.close", connectionId }).catch(() => undefined);
    }
  }

  private sendProviderInput(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    input: ProviderInput,
  ): Promise<void> {
    if (state.closed) return Promise.reject(new Error("Provider connection is closed"));
    try {
      if (input.type === "session.open" || !("sessionId" in input)) {
        requireProviderCapabilities(state.capabilities, input);
      } else {
        const capabilities = state.sessions.get(input.sessionId);
        if (!capabilities) throw new Error(`Unknown provider session: ${input.sessionId}`);
        requireProviderCapabilities(capabilities, input);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const child = loaded.child;
    if (!child) return Promise.reject(new Error(`Plugin has no server entry: ${loaded.id}`));
    const acceptanceId = randomUUID();
    return new Promise((resolve, reject) => {
      state.pendingSends.set(acceptanceId, { input, resolve, reject });
      void send(child, {
        type: "provider.send",
        connectionId,
        acceptanceId,
        input: jsonTransportValue(input),
      }).catch((error) => {
        state.pendingSends.delete(acceptanceId);
        reject(error);
      });
    });
  }

  private async closeProviderConnection(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
  ): Promise<void> {
    if (state.closed) return;
    const child = loaded.child;
    if (!child) throw new Error(`Plugin has no server entry: ${loaded.id}`);
    await send(child, { type: "provider.close", connectionId });
    await state.closedPromise;
  }

  private publishProviderEvent(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    event: ProviderEvent,
  ): void {
    if (
      event.type === "timeline.item" &&
      event.item.type === "plugin" &&
      event.item.pluginId !== loaded.id
    ) {
      this.failProviderConnection(
        loaded,
        connectionId,
        state,
        new Error(
          `Provider plugin ${loaded.id} cannot emit timeline items for ${event.item.pluginId}`,
        ),
      );
      return;
    }
    if (event.type === "session.opened") {
      const knownCapabilities = new Set<string>(PROVIDER_CAPABILITIES);
      const invalidCapability = event.capabilities.find(
        (capability) =>
          knownCapabilities.has(capability) && !state.capabilities.includes(capability),
      );
      if (invalidCapability) {
        this.failProviderConnection(
          loaded,
          connectionId,
          state,
          new Error(`Provider session selected an unoffered capability: ${invalidCapability}`),
        );
        return;
      }
      const selectedCapabilities = event.capabilities;
      event = {
        ...event,
        capabilities: PROVIDER_CAPABILITIES.filter((capability) =>
          selectedCapabilities.includes(capability),
        ),
      };
      if (
        event.parentSessionId &&
        !state.sessions.get(event.parentSessionId)?.includes("session.subsession")
      ) {
        this.failProviderConnection(
          loaded,
          connectionId,
          state,
          new Error(`Provider parent session did not negotiate session.subsession`),
        );
        return;
      }
    }
    if (event.type === "session.opened") {
      state.sessions.set(event.sessionId, event.capabilities);
    }
    for (const listener of state.listeners) listener(event);
    if (event.type === "session.closed") state.sessions.delete(event.sessionId);
  }

  private failProviderConnection(
    loaded: LoadedPlugin,
    connectionId: string,
    state: RemoteProviderConnection,
    error: Error,
  ): void {
    loaded.providerConnections.delete(connectionId);
    this.failRemoteProviderConnection(state, error);
    if (loaded.child?.connected) {
      void send(loaded.child, { type: "provider.close", connectionId }).catch(() => undefined);
    }
  }

  private trackAcceptedProviderInput(state: RemoteProviderConnection, input: ProviderInput): void {
    if (input.type === "session.open" && !state.sessions.has(input.sessionId)) {
      state.sessions.set(input.sessionId, []);
    }
    if (input.type === "session.close") state.sessions.delete(input.sessionId);
  }

  private handleMalformedChildMessage(
    loaded: LoadedPlugin,
    rawMessage: unknown,
    error: Error,
  ): void {
    const connectionId = readConnectionId(rawMessage);
    const state = connectionId ? loaded.providerConnections.get(connectionId) : undefined;
    if (!connectionId || !state) {
      this.appendLog(loaded.id, "stderr", `[paseo] ${error.message}`);
      terminatePluginChild(loaded.child!);
      return;
    }
    this.failProviderConnection(loaded, connectionId, state, error);
  }

  private failRemoteProviderConnection(state: RemoteProviderConnection, error: Error): void {
    if (state.closed) return;
    for (const sessionId of state.sessions.keys()) {
      const event: ProviderEvent = {
        type: "session.runtime_failed",
        sessionId,
        error: { message: error.message },
      };
      for (const listener of state.listeners) listener(event);
    }
    state.closed = true;
    state.rejectConnected(error);
    this.rejectProviderSends(state, error.message);
    state.rejectClosed(error);
  }

  private rejectProviderSends(state: RemoteProviderConnection, message: string): void {
    for (const pending of state.pendingSends.values()) pending.reject(new Error(message));
    state.pendingSends.clear();
  }

  private async handleChildClose(loaded: LoadedPlugin): Promise<void> {
    loaded.sessionSocket?.peerClosed();
    const wasPublished = this.plugins.get(loaded.id) === loaded;
    if (wasPublished) {
      this.plugins.delete(loaded.id);
      this.notifySessionOpenChange(loaded);
    }
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`);
    for (const state of loaded.providerConnections.values()) {
      this.failRemoteProviderConnection(state, new Error(`Plugin process exited: ${loaded.id}`));
    }
    loaded.providerConnections.clear();
    await loaded.sessionClosed;
    if (wasPublished) this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    this.appendLog(loaded.id, "stdout", "[paseo] Stopping plugin");
    for (const [connectionId, state] of loaded.providerConnections) {
      if (state.connected) continue;
      this.abandonProviderConnect(
        loaded,
        connectionId,
        state,
        new Error(`Plugin stopped: ${loaded.id}`),
      );
    }
    const { child, sessionSocket, sessionClosed } = loaded;
    if (!child || !sessionSocket || !sessionClosed) {
      this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
      return;
    }
    const termination = loaded.termination;
    if (!termination) throw new Error("Plugin child termination tracking is missing");
    if (termination.closed) {
      sessionSocket.peerClosed();
      await sessionClosed;
      this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
      return;
    }
    const closed = termination.completion;
    if (child instanceof InternalPluginChild) {
      try {
        await child.retire();
        await closed;
        sessionSocket.peerClosed();
        await sessionClosed;
        this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
        return;
      } catch (error) {
        loaded.executionOwner?.markUnknown();
        throw error;
      }
    }
    if (child.connected) {
      await send(child, { type: "shutdown" }).catch(() => undefined);
    }
    let forceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SOFT_SHUTDOWN_TIMEOUT_MS);
    }, SOFT_SHUTDOWN_TIMEOUT_MS);
    await closed.finally(() => {
      if (forceTimer) clearTimeout(forceTimer);
    });
    sessionSocket.peerClosed();
    await sessionClosed;
    this.appendLog(loaded.id, "stdout", "[paseo] Plugin stopped");
  }

  /** Rejects in-flight requests and closes open subscriptions with the reason. */
  private rejectPending(loaded: LoadedPlugin, message: string): void {
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(message));
    }
    loaded.pending.clear();
    const subscriptions = [...loaded.subscriptions.values()];
    loaded.subscriptions.clear();
    for (const subscription of subscriptions) subscription.closed(message);
  }

  private appendLog(pluginId: string, stream: PluginLogEntry["stream"], message: string): void {
    const boundedMessage = Buffer.from(message).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8");
    let tail = this.logTails.get(pluginId);
    if (!tail) {
      tail = { entries: [], bytes: 0, nextSequence: 1 };
      this.logTails.set(pluginId, tail);
    }
    const entry: PluginLogEntry = {
      sequence: tail.nextSequence++,
      timestamp: new Date().toISOString(),
      stream,
      message: boundedMessage,
    };
    tail.entries.push(entry);
    tail.bytes += Buffer.byteLength(boundedMessage);
    while (tail.entries.length > MAX_LOG_ENTRIES || tail.bytes > MAX_LOG_BYTES) {
      const removed = tail.entries.shift();
      if (!removed) break;
      tail.bytes -= Buffer.byteLength(removed.message);
    }
    this.logger.info({ pluginId, ...entry }, "Plugin output");
  }

  private notify(pluginId: string, error?: string): void {
    for (const listener of this.listeners) listener(pluginId, error);
  }
}

function isSessionHelloFrame(input: { frame: string | Uint8Array; isBinary: boolean }): boolean {
  const { frame, isBinary } = input;
  if (isBinary || typeof frame !== "string") return false;
  try {
    return (JSON.parse(frame) as { type?: unknown }).type === "hello";
  } catch {
    return false;
  }
}

function readConnectionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const connectionId = Reflect.get(value, "connectionId");
  return typeof connectionId === "string" ? connectionId : null;
}

function assertProfileClosure(profile: PassivePluginProfile, child: QualifiedOwnedChild): void {
  if (
    profile.runtimeClosureSha256 !== child.closure.runtimeClosureSha256 ||
    profile.helperClosureSha256 !== child.closure.helperClosureSha256 ||
    profile.qualificationSha256 !== child.closure.qualificationSha256
  )
    throw new Error("Protected plugin profile differs from actual executing closure");
}
