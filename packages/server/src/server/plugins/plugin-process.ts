import { PluginActivityOwner, type PluginActivityLease } from "@getpaseo/plugin/internal/activity";
import {
  isPluginExecutionRoot,
  pluginExecutionKey,
  type PluginExecutionRoot,
} from "./execution-roots.js";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { PluginAgentTools } from "./agent-tools.js";
import { PluginHookHandlers } from "./lifecycle/index.js";
import { evaluateBundle } from "./bundle-evaluator.js";
import {
  PluginProcessRequestSchema,
  type PluginProcessMessage,
  type PluginProcessRequest,
} from "./plugin-process-protocol.js";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import type {
  SettingsDefinition,
  PluginRpcContract,
  PluginSubscriptionContract,
} from "@getpaseo/plugin";
import type {
  PluginHandlerContext,
  PluginServerContext,
  PluginServerContribution,
} from "@getpaseo/plugin/server";
import { assertPluginWireValue } from "@getpaseo/protocol/binary-frames/index";
import {
  PluginSubscriptionHandlers,
  type PluginSubscriptionHandler,
} from "./subscription-handlers.js";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderRegistration,
  ProviderStatusSchema,
} from "@getpaseo/plugin/server/provider";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { createPluginClientId } from "./plugin-session-identity.js";

import { PluginSettingsStore } from "./settings/index.js";
import { readPluginProviderIcon } from "./provider-icon.js";
import { initializeEnvironmentProxy } from "../network/index.js";
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PluginWorkerChannel {
  send(message: PluginProcessMessage, callback?: () => void): void;
  onMessage(handler: (message: PluginProcessRequest) => void): () => void;
  disconnect(): void;
}

async function validateSourceDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory))
    throw new Error("Plugin source directory must be absolute and canonical");
  const canonical = await realpath(directory);
  if (canonical !== directory)
    throw new Error("Plugin source directory must be absolute and canonical");
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Plugin source directory must be a directory");
  return canonical;
}

class HostInitializationRejection extends Error {}

export function createPluginWorker(
  options: { channel: PluginWorkerChannel } & (
    | { contribute: PluginServerContribution }
    | { loadContribution: (source: string) => PluginServerContribution }
  ),
): { shutdown(): Promise<void>; readonly activityOwner: PluginActivityOwner } {
  const { channel } = options;
  const activity = new PluginActivityOwner(() =>
    send({ type: "execution.unknown", instanceId: hostInstanceId }),
  );
  let hostInstanceId = "legacy-unbound";
  let qualifiedPassive = false;
  let initializationStarted = false;
  let initializationRejected = false;
  const initializationErrors = new WeakSet<object>();
  let registrationPhase = false;
  let deferredInitializationError: Error | undefined;
  function rejectInitialization(message: string): Error {
    const error = new HostInitializationRejection(message);
    initializationErrors.add(error);
    return error;
  }
  let settingsStore: PluginSettingsStore | null = null;
  function registerSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
    if (!settingsStore) throw new Error("Plugin settings storage is unavailable");
    const handlers = settingsStore.register(definition);
    register(handlers.read.contract, handlers.read.handle);
    register(handlers.write.contract, (input) =>
      handlers.write.handle(handlers.write.contract.input.parse(input)),
    );
    register(handlers.reset.contract, (input) =>
      handlers.reset.handle(handlers.reset.contract.input.parse(input)),
    );
    return {
      read: handlers.settings.read,
      subscribe(listener: Parameters<typeof handlers.settings.subscribe>[0]) {
        const lifetime = activity.retainCurrent();
        try {
          const unsubscribe = handlers.settings.subscribe((state) => {
            const invocation = lifetime.run(() => activity.retainCurrent());
            return invocation.run(async () => {
              try {
                await listener(state);
              } finally {
                invocation.release();
              }
            });
          });
          return () => {
            try {
              lifetime.run(unsubscribe);
            } finally {
              lifetime.release();
            }
          };
        } catch (error) {
          lifetime.release();
          throw error;
        }
      },
    };
  }

  type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

  interface RegisteredRpc {
    contract: PluginRpcContract;
    handler: RpcHandler;
  }

  const agentTools = new PluginAgentTools();
  const hooks = new PluginHookHandlers(() => {
    send({ type: "hooks.changed", hooks: hooks.catalog() });
  }, agentTools);
  const handlers = new Map<string, RegisteredRpc>();
  const subscriptions = new PluginSubscriptionHandlers({ send, sendAndWait }, activity);
  const providers = new Map<string, ProviderRegistration>();
  const usageSources = new Map<string, UsageSourceRegistration>();
  const providerConnections = new Map<
    string,
    {
      connection: ProviderConnection;
      unsubscribe: () => void;
      activity: PluginActivityLease;
      closing?: Promise<void>;
    }
  >();
  const pendingProviderConnections = new Map<string, { tombstoned: boolean }>();
  let cleanup: (() => void | Promise<void>) | null = null;
  let daemonClient: DaemonClient | null = null;
  let paseo: PaseoApi | null = null;
  let stopping = false;
  function send(message: PluginProcessMessage): void {
    try {
      channel.send(message);
    } catch {
      activity.markUnknown();
    }
  }

  function sendAndWait(message: PluginProcessMessage): Promise<void> {
    return new Promise((resolve) => {
      channel.send(message, () => resolve());
    });
  }

  function jsonTransportValue<Value>(value: Value): Value {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
    return JSON.parse(encoded) as Value;
  }

  function rejectRegistration(message: string): undefined {
    const error = rejectInitialization(message);
    if (!qualifiedPassive || !registrationPhase) throw error;
    // Defer fixed registration validation until the contribution returns its VALID
    // cleanup. A malformed/missing cleanup or arbitrary throw is always fatal.
    deferredInitializationError ??= error;
    return undefined;
  }
  function validateMethod(method: string): string | undefined {
    const normalized = method.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(normalized)) {
      return rejectRegistration(`Invalid plugin RPC method: ${method}`);
    }
    if (handlers.has(normalized) || subscriptions.has(normalized)) {
      return rejectRegistration(`Duplicate plugin RPC method: ${normalized}`);
    }
    return normalized;
  }

  function registerSubscription(
    contract: PluginSubscriptionContract,
    handler: PluginSubscriptionHandler,
  ): void {
    if (typeof handler !== "function") {
      return rejectRegistration(`Plugin subscription ${contract.name} must provide a handler`);
    }
    const method = validateMethod(contract.name);
    if (method === undefined) return;
    subscriptions.register({ ...contract, name: method }, handler);
  }

  // One name serves either an RPC or a subscription; the contract says which.
  const handle = ((
    contract: PluginRpcContract | PluginSubscriptionContract,
    handler: (input: unknown, context: never) => unknown,
  ) => {
    if ("event" in contract) {
      // The subscription handlers parse the input once and pass the result here.
      registerSubscription(contract, handler as PluginSubscriptionHandler);
      return;
    }
    register(contract, (input, context) => handler(input, context as never));
  }) as PluginServerContext["handle"];

  function register(contract: PluginRpcContract, handler: RpcHandler): void {
    if (typeof handler !== "function") {
      return rejectRegistration(`Plugin RPC ${contract.name} must provide a handler`);
    }
    const method = validateMethod(contract.name);
    if (method === undefined) return;
    handlers.set(method, { contract: { ...contract, name: method }, handler });
  }

  function registerProvider(provider: ProviderRegistration): void {
    const id = provider.id.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
      throw new Error(`Invalid plugin provider ID: ${provider.id}`);
    }
    if (!provider.label.trim()) throw new Error(`Plugin provider ${id} requires a label`);
    if (typeof provider.connect !== "function") {
      throw new Error(`Plugin provider ${id} must implement connect()`);
    }
    if (
      provider.getCatalogCacheKey !== undefined &&
      typeof provider.getCatalogCacheKey !== "function"
    ) {
      throw new Error(`Invalid catalogue key callback for plugin provider ${id}`);
    }
    if (provider.status !== undefined && typeof provider.status !== "function")
      throw new Error(`Invalid status callback for plugin provider ${id}`);
    if (
      provider.command !== undefined &&
      (provider.command.length === 0 ||
        provider.command.some((part) => typeof part !== "string" || !part.trim()))
    )
      throw new Error(`Invalid command for plugin provider ${id}`);
    if (providers.has(id)) throw new Error(`Duplicate plugin provider ID: ${id}`);
    providers.set(id, { ...provider, id });
  }

  function registerUsageSource(source: UsageSourceRegistration): void {
    const id = source.id.trim();
    if (
      !/^[a-z][a-z0-9._-]*$/.test(id) ||
      !source.label.trim() ||
      typeof source.fetch !== "function" ||
      typeof source.discover !== "function" ||
      !source.input ||
      typeof source.input.parseAsync !== "function"
    ) {
      throw new Error(`Invalid usage source: ${source.id}`);
    }
    if (usageSources.has(id)) throw new Error(`Duplicate usage source: ${id}`);
    usageSources.set(id, { ...source, id });
  }

  function providerMetadata(provider: ProviderRegistration) {
    return {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      iconPath: provider.icon,
      requiresConfiguration: provider.requiresConfiguration,
      hasCatalogCacheKey: provider.getCatalogCacheKey !== undefined,
      hasStatus: provider.status !== undefined,
      command: provider.command,
    };
  }

  async function connectProvider(
    message: Extract<PluginProcessRequest, { type: "provider.connect" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const provider = providers.get(message.providerId);
    if (!provider) throw new Error(`Unknown plugin provider: ${message.providerId}`);
    if (
      providerConnections.has(message.connectionId) ||
      pendingProviderConnections.has(message.connectionId)
    ) {
      throw new Error(`Duplicate provider connection: ${message.connectionId}`);
    }
    const pending = { tombstoned: false };
    pendingProviderConnections.set(message.connectionId, pending);
    let connection: ProviderConnection;
    const connectionActivity = activity.retainCurrent();
    try {
      connection = await connectionActivity.run(() => provider.connect(message.request));
    } catch (error) {
      connectionActivity.release();
      pendingProviderConnections.delete(message.connectionId);
      if (pending.tombstoned || stopping) return;
      throw error;
    }
    pendingProviderConnections.delete(message.connectionId);
    if (pending.tombstoned || stopping) {
      try {
        await connectionActivity.run(() => connection.close());
        connectionActivity.release();
      } catch {
        activity.markUnknown();
      }
      return;
    }
    let unsubscribe = () => {};
    unsubscribe = connection.onEvent((event) => {
      try {
        send({
          type: "provider.event",
          connectionId: message.connectionId,
          event: ProviderEventSchema.parse(jsonTransportValue(event)),
        });
      } catch (error) {
        void closeProviderConnection(message.connectionId);
        send({
          type: "provider.closed",
          connectionId: message.connectionId,
          error: describeError(error),
        });
      }
    });
    providerConnections.set(message.connectionId, {
      connection,
      unsubscribe,
      activity: connectionActivity,
    });
    send({
      type: "provider.connected",
      connectionId: message.connectionId,
      version: connection.version,
      capabilities: connection.capabilities,
    });
  }

  async function sendProviderInput(
    message: Extract<PluginProcessRequest, { type: "provider.send" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const current = providerConnections.get(message.connectionId);
    if (!current) throw new Error(`Unknown provider connection: ${message.connectionId}`);
    if (current.closing) throw new Error("Provider connection is closing");
    await current.connection.send(message.input);
    send({
      type: "provider.accepted",
      connectionId: message.connectionId,
      acceptanceId: message.acceptanceId,
    });
  }

  // The connection stays registered until its close has reported, so shutdown
  // waits for a close already in flight instead of disconnecting underneath it.
  async function closeProviderConnection(connectionId: string): Promise<void> {
    const current = providerConnections.get(connectionId);
    if (!current) return;
    if (current.closing) return current.closing;
    const closing = (async () => {
      current.unsubscribe();
      try {
        await current.activity.run(() => current.connection.close());
        current.activity.release();
        send({ type: "provider.closed", connectionId });
      } catch (error) {
        activity.markUnknown();
        send({ type: "provider.closed", connectionId, error: describeError(error) });
      } finally {
        providerConnections.delete(connectionId);
      }
    })();
    current.closing = closing;
    return closing;
  }

  const transportFactory = createPluginDaemonTransportFactory({
    send,
    onMessage(handler) {
      return channel.onMessage(handler);
    },
  });

  async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
    if (initializationStarted) {
      activity.markUnknown();
      throw new Error("Plugin initialization already started");
    }
    initializationStarted = true;
    const sourceDirectory = await validateSourceDirectory(message.pluginDirectory);
    hostInstanceId = message.hostInstanceId ?? "legacy-unbound";
    qualifiedPassive = message.passiveInitialization?.contract === "native-passive-contract-1";
    if (qualifiedPassive) activity.qualifyPassive();
    if (message.passiveInitialization?.hold) activity.begin(message.passiveInitialization.hold);
    const initializationActivity = qualifiedPassive
      ? activity.initialization()
      : activity.acquire();
    try {
      daemonClient = new DaemonClient({
        url: `ipc://plugin/${encodeURIComponent(message.pluginId)}`,
        clientId: createPluginClientId(message.pluginId),
        clientType: "cli",
        appVersion: message.appVersion,
        // The runtime re-attaches a session when the daemon drops this socket.
        reconnect: { enabled: true },
        transportFactory,
      });
      paseo = createPaseoApi(daemonClient);
      await daemonClient.connect();
      settingsStore = message.settingsDirectory
        ? new PluginSettingsStore(message.settingsDirectory, (settingsId) =>
            send({ type: "settings.changed", settingsId }),
          )
        : null;
      const context: PluginServerContext = {
        sourceDirectory,
        managedSource: message.managedSource === true,
        handle,
        registerProvider,
        registerUsageSource,
        registerSettings,
        addHook: hooks.addHook,
        on: hooks.on,
        before: hooks.before,
      };
      Object.defineProperty(context, "sourceDirectory", {
        value: sourceDirectory,
        writable: false,
        configurable: false,
        enumerable: true,
      });
      // Load/evaluate top-level code only after owner, inherited hold and initialization scope exist.
      Object.defineProperty(context, "managedSource", {
        value: message.managedSource === true,
        writable: false,
        configurable: false,
        enumerable: true,
      });
      const contribute = initializationActivity.run(() =>
        "contribute" in options ? options.contribute : options.loadContribution(message.bundle),
      );
      registrationPhase = true;
      const contributedCleanup = initializationActivity.run(() => contribute(context));
      registrationPhase = false;
      if (typeof contributedCleanup !== "function") {
        throw new Error("Plugin contribution must return a cleanup function");
      }
      cleanup = contributedCleanup;
      if (deferredInitializationError) throw deferredInitializationError;
      const usageSourceMetadata = await Promise.all(
        [...usageSources.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(async (source) => ({
            id: source.id,
            label: source.label,
            icon: source.icon
              ? await readPluginProviderIcon(message.pluginDirectory, source.icon)
              : undefined,
          })),
      );
      send({
        type: "ready",
        methods: [...handlers.keys()].sort(),
        subscriptions: subscriptions.catalog(),
        hooks: hooks.catalog(),
        providers: [...providers.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(providerMetadata),
        usageSources: usageSourceMetadata,
      });
    } finally {
      registrationPhase = false;
      initializationActivity.release();
    }
  }

  let shutdownCompletion: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (shutdownCompletion) return shutdownCompletion;
    stopping = true;
    shutdownCompletion = finishShutdown();
    return shutdownCompletion;
  }
  async function finishShutdown(disconnect = true): Promise<void> {
    const retirement = activity.retirementCleanup();
    try {
      await retirement.run(async () => {
        const releaseApi = paseo?.dispose();
        hooks.close();
        agentTools.close();
        subscriptions.releaseAll();
        for (const pending of pendingProviderConnections.values()) pending.tombstoned = true;
        const currentCleanup = cleanup;
        cleanup = null;
        // Actual cleanup failure leaves retirement unknown; it cannot become a close ACK.
        await currentCleanup?.();
        await Promise.all([...providerConnections.keys()].map(closeProviderConnection));
        await releaseApi;
        await daemonClient?.close();
      });
    } catch (error) {
      activity.markUnknown();
      throw error;
    } finally {
      retirement.release();
    }
    await activity.waitForRetirement();
    await sendAndWait({ type: "paseo_close" });
    daemonClient = null;
    paseo = null;
    if (disconnect) channel.disconnect();
  }

  function rejectRoot(message: PluginExecutionRoot, error: unknown): void {
    const reason = describeError(error);
    if (message.type === "provider.connect")
      send({ type: "provider.connect_failed", connectionId: message.connectionId, error: reason });
    else if (message.type === "provider.send")
      send({
        type: "provider.rejected",
        connectionId: message.connectionId,
        acceptanceId: message.acceptanceId,
        error: reason,
      });
    else send({ type: "error", requestId: message.requestId, error: reason });
  }

  async function invokeRoot(
    message: Extract<PluginProcessRequest, { type: "invoke" }>,
  ): Promise<unknown> {
    const registered = handlers.get(message.method);
    if (!registered) throw new Error(`Unknown RPC method: ${message.method}`);
    const input = await registered.contract.input.parseAsync(message.input);
    if (!paseo) throw new Error("Plugin Paseo API is unavailable");
    const output = await registered.handler(input, { paseo });
    assertPluginWireValue(output, "output");
    return output;
  }

  async function usageRoot(
    message: Extract<PluginProcessRequest, { type: "usage.fetch" | "usage.discover" }>,
  ): Promise<unknown> {
    const source = usageSources.get(message.sourceId);
    if (!source) throw new Error(`Unknown usage source: ${message.sourceId}`);
    if (message.type === "usage.discover")
      return jsonTransportValue(await source.discover(message.scope));
    return jsonTransportValue(await source.fetch(await source.input.parseAsync(message.input)));
  }

  async function dispatchRoot(message: PluginExecutionRoot): Promise<void> {
    if (!paseo) throw new Error("Plugin API unavailable");
    let output: unknown;
    switch (message.type) {
      case "invoke":
        output = await invokeRoot(message);
        break;
      case "hook":
        output = await hooks.invoke(message.requestId, message.name, message.input, paseo);
        break;
      case "tool.call":
        output = jsonTransportValue(
          await agentTools.call(
            message.requestId,
            message.agent,
            message.name,
            message.input,
            paseo,
          ),
        );
        break;
      case "usage.fetch":
      case "usage.discover":
        output = await usageRoot(message);
        break;
      case "provider.status": {
        const provider = providers.get(message.providerId);
        if (!provider?.status)
          throw new Error(`Provider has no status capability: ${message.providerId}`);
        output = ProviderStatusSchema.parse(await provider.status(message.request));
        break;
      }
      case "provider.catalog_key": {
        const provider = providers.get(message.providerId);
        if (!provider) throw new Error(`Unknown provider: ${message.providerId}`);
        output = await provider.getCatalogCacheKey?.(message.options);
        if (output !== undefined && typeof output !== "string")
          throw new Error("Invalid catalogue key");
        break;
      }
      case "provider.connect":
        await connectProvider(message);
        return;
      case "provider.send":
        await sendProviderInput(message);
        return;
      case "subscribe":
        subscriptions.start(message, paseo);
        return;
    }
    send({ type: "result", requestId: message.requestId, output });
  }

  function admitRoot(message: PluginExecutionRoot): void {
    const requestKey = pluginExecutionKey(message);
    const settled = () =>
      send({ type: "execution.settled", requestKey, instanceId: hostInstanceId });
    let lease: PluginActivityLease;
    try {
      if (stopping) throw new Error("Plugin is stopping");
      lease = activity.acquire(settled);
    } catch (error) {
      rejectRoot(message, error);
      settled();
      return;
    }
    void lease
      .run(() => dispatchRoot(message))
      .catch((error) => rejectRoot(message, error))
      .finally(() => lease.release());
  }

  function handleMaintenance(
    message: Extract<PluginProcessRequest, { type: "maintenance.begin" | "maintenance.end" }>,
  ): void {
    try {
      if (message.instanceId !== hostInstanceId)
        throw new Error("Plugin maintenance incarnation mismatch");
      if (message.type === "maintenance.end") {
        activity.end(message);
        send({
          type: "result",
          requestId: message.requestId,
          output: { status: "ended", ...message },
        });
        return;
      }
      const status = activity.begin(message);
      send({
        type: "result",
        requestId: message.requestId,
        output: {
          status: qualifiedPassive ? status : "unknown",
          generation: message.generation,
          transactionId: message.transactionId,
          instanceId: hostInstanceId,
        },
      });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, error: describeError(error) });
    }
  }

  function rejectInvalidProviderInput(raw: unknown, reason: string): boolean {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("connectionId" in raw) ||
      typeof raw.connectionId !== "string" ||
      !("acceptanceId" in raw) ||
      typeof raw.acceptanceId !== "string"
    )
      return false;
    send({
      type: "provider.rejected",
      connectionId: raw.connectionId,
      acceptanceId: raw.acceptanceId,
      error: `Invalid provider input: ${reason}`,
    });
    void closeProviderConnection(raw.connectionId);
    return true;
  }

  async function retireRejectedInitialization(
    message: Extract<PluginProcessRequest, { type: "initialization.retire" }>,
  ): Promise<void> {
    if (
      !initializationRejected ||
      !qualifiedPassive ||
      message.instanceId !== hostInstanceId ||
      stopping ||
      activity.begin(message) !== "held"
    )
      throw new Error("Initialization retirement is uncertain");
    stopping = true;
    shutdownCompletion = finishShutdown(false);
    await shutdownCompletion;
    await sendAndWait({
      type: "initialization.retired",
      requestId: message.requestId,
      instanceId: hostInstanceId,
      generation: message.generation,
      transactionId: message.transactionId,
    });
    channel.disconnect();
  }

  function handleMessage(rawMessage: unknown): void {
    const parsed = PluginProcessRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      if (rejectInvalidProviderInput(rawMessage, parsed.error.message)) return;
      activity.markUnknown();
      send({ type: "fatal", error: `Invalid plugin process request: ${parsed.error.message}` });
      void shutdown().catch((error) => {
        activity.markUnknown();
        console.error("Plugin shutdown failed", error);
      });
      return;
    }
    const message = parsed.data;
    if (isPluginExecutionRoot(message)) {
      admitRoot(message);
      return;
    }
    switch (message.type) {
      case "initialize":
        void initialize(message).catch(async (error) => {
          if (
            qualifiedPassive &&
            cleanup !== null &&
            error instanceof HostInitializationRejection &&
            initializationErrors.has(error)
          ) {
            initializationRejected = true;
            send({ type: "initialization.rejected", instanceId: hostInstanceId });
            return;
          }
          send({ type: "fatal", error: describeError(error) });
          await paseo
            ?.dispose()
            .catch((failure) => console.error("Plugin API cleanup failed", failure));
          await daemonClient?.close().catch(() => undefined);
        });
        return;
      case "initialization.retire":
        void retireRejectedInitialization(message).catch((error) => {
          activity.markUnknown();
          send({ type: "fatal", error: describeError(error) });
        });
        return;
      case "shutdown":
        void shutdown().catch((error) => {
          activity.markUnknown();
          console.error("Plugin shutdown failed", error);
        });
        return;
      case "maintenance.begin":
      case "maintenance.end":
        handleMaintenance(message);
        return;
      case "hook.cancel":
        hooks.cancel(message.requestId);
        return;
      case "tool.cancel":
        agentTools.cancel(message.requestId);
        return;
      case "tools.detach":
        agentTools.detach(message.agentId);
        return;
      case "unsubscribe":
        subscriptions.release(message.subscriptionId);
        return;
      case "provider.close":
        void closeProviderConnection(message.connectionId);
        return;
      case "paseo_frame":
      case "paseo_close":
        return;
    }
  }
  channel.onMessage(handleMessage);

  return Object.freeze({ shutdown, activityOwner: activity });
}

/** Producer entry supplies its fixed evaluator after private host validation and helper admission. */
export function attachPluginWorkerChannel(
  channel: PluginWorkerChannel,
  loadContribution: (source: string) => PluginServerContribution,
): ReturnType<typeof createPluginWorker> {
  return createPluginWorker({
    channel,
    loadContribution: (source) => {
      initializeEnvironmentProxy();
      return loadContribution(source);
    },
  });
}

// Producer defines this only at build time so a sealed import cannot auto-wire before validation.
declare const __PASEO_QUALIFIED_PLUGIN_ENTRY__: true | undefined;
if (
  typeof __PASEO_QUALIFIED_PLUGIN_ENTRY__ === "undefined" &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  const channel: PluginWorkerChannel = {
    send(message, callback) {
      if (callback) process.send?.(message, () => callback());
      else process.send?.(message);
    },
    onMessage(handler) {
      const receive = (message: unknown) => handler(message as PluginProcessRequest);
      process.on("message", receive);
      return () => {
        process.off("message", receive);
      };
    },
    disconnect() {
      process.disconnect();
    },
  };
  attachPluginWorkerChannel(channel, evaluateBundle);
}
