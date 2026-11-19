import { request } from "node:http";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { parseAgentMessage } from "./agent-messages/index.js";

const artifactDir = process.env.REPRO_ARTIFACT_DIR ?? path.join(process.cwd(), "repro-artifacts");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The daemon receives real HTTP/MCP requests, exclusively over a private Unix socket.
function unixFetch(socketPath: string): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    const url = new URL(req.url);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          path: url.pathname + url.search,
          method: req.method,
          headers: Object.fromEntries(req.headers),
        },
        (incoming) => {
          const headers = new Headers();
          for (const [key, val] of Object.entries(incoming.headers)) {
            if (val !== undefined) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
          }
          resolve(
            new Response(
              req.method === "HEAD" || incoming.statusCode === 204
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status: incoming.statusCode, headers },
            ),
          );
        },
      );
      outgoing.on("error", reject);
      const abort = () => outgoing.destroy(new Error("Unix fetch aborted"));
      req.signal.addEventListener("abort", abort, { once: true });
      outgoing.on("close", () => req.signal.removeEventListener("abort", abort));
      if (req.signal.aborted) abort();
      outgoing.end(body);
    });
  };
}

const cases = [
  { id: "S1", relation: "siblings", running: false },
  { id: "S2", relation: "siblings", running: true },
  { id: "S3", relation: "A-child", running: false },
  { id: "S4", relation: "A-child", running: true },
  { id: "S5", relation: "B-child", running: false },
  { id: "S6-before", relation: "siblings", running: false, cancel: "before" },
  { id: "S6-after", relation: "siblings", running: false, cancel: "after" },
  { id: "S6-child-before", relation: "A-child", running: false, cancel: "before" },
  { id: "S6-child-after", relation: "A-child", running: false, cancel: "after" },
  { id: "S7", relation: "self", running: false },
];

test.each(cases)(
  "$id: scoped archive with $relation, running=$running",
  async (scenario) => {
    // Short path stays within macOS sockaddr_un's length limit.
    await mkdir(artifactDir, { recursive: true });
    const root = await mkdtemp("/tmp/p10118-");
    const home = path.join(root, "home");
    await mkdir(home);
    const socket = path.join(root, "daemon.sock");
    const events: string[] = [];
    const ids = new Map<string, string>();
    const busyStarted = deferred();
    const busyRelease = deferred();
    const logs: string[] = [];
    const clients = createTestAgentClients({
      async beforeTurnComplete(prompt) {
        if (
          typeof prompt === "string" &&
          (parseAgentMessage(prompt)?.text ?? prompt) === "HOLD_B"
        ) {
          busyStarted.resolve();
          await busyRelease.promise;
        }
      },
      onInterrupt() {
        events.push("interrupt");
        busyRelease.resolve();
      },
    });
    for (const client of Object.values(clients)) {
      const create = client.createSession.bind(client);
      client.createSession = async (...args) => {
        const session = await create(...args);
        const close = session.close.bind(session);
        session.close = async () => {
          events.push(`close:${args[0].title}`);
          await close();
        };
        return session;
      };
    }
    const daemon = await createPaseoDaemon(
      {
        listen: socket,
        paseoHome: home,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir: root,
        mcpDebug: false,
        agentClients: clients,
        agentStoragePath: path.join(home, "agents"),
        relayEnabled: false,
        relayEndpoint: "relay.paseo.sh:443",
        appBaseUrl: "https://app.paseo.sh",
        pluginsEnabled: false,
      },
      pino(
        { level: "debug" },
        {
          write(line) {
            logs.push(line);
          },
        },
      ),
      { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
    );
    const connections: Client[] = [];
    const connect = async (caller?: string) => {
      const client = new Client({ name: "10118-repro", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost/mcp/agents${caller ? `?callerAgentId=${caller}` : ""}`),
          { fetch: unixFetch(socket) },
        ),
      );
      connections.push(client);
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };
    const archived = async (id: string) => Boolean((await daemon.agentStorage.get(id))?.archivedAt);
    let releaseArchive: (() => void) | undefined;
    try {
      await daemon.start();
      expect(daemon.getListenTarget()).toEqual({ type: "socket", path: socket });
      const top = await connect();
      const create = async (client: Client, title: string, child = false) => {
        const result = await call(client, "create_agent", {
          relationship: { kind: child ? "subagent" : "detached" },
          workspace: child
            ? { kind: "current" }
            : { kind: "create", source: { kind: "directory", path: root } },
          provider: "codex/gpt-5.4",
          title,
          initialPrompt: "done",
          settings: { modeId: "full-access" },
          notifyOnFinish: false,
        });
        const id = result.agentId as string;
        ids.set(id, title);
        await vi.waitFor(() => expect(daemon.agentManager.getAgent(id)?.lifecycle).toBe("idle"));
        return id;
      };
      let A: string;
      let B: string;
      if (scenario.relation === "A-child") {
        B = await create(top, "B");
        A = await create(await connect(B), "A", true);
        expect((await daemon.agentStorage.get(A))?.labels?.[PARENT_AGENT_ID_LABEL]).toBe(B);
      } else {
        A = await create(top, "A");
        B =
          scenario.relation === "self"
            ? A
            : await create(
                scenario.relation === "B-child" ? await connect(A) : top,
                "B",
                scenario.relation === "B-child",
              );
      }
      const caller = await connect(A);
      if (scenario.running) {
        await call(top, "send_agent_prompt", {
          agentId: B,
          prompt: "HOLD_B",
          notifyOnFinish: false,
        });
        await busyStarted.promise;
        expect(daemon.agentManager.getAgent(B)?.lifecycle).toBe("running");
      }
      const upsert = daemon.agentStorage.upsert.bind(daemon.agentStorage);
      const seen = new Set<string>();
      vi.spyOn(daemon.agentStorage, "upsert").mockImplementation(async (...args) => {
        await upsert(...args);
        if (args[0].archivedAt && !seen.has(args[0].id)) {
          seen.add(args[0].id);
          events.push(`archived:${ids.get(args[0].id)}`);
        }
      });
      const entered = deferred();
      const release = deferred();
      const finished = deferred();
      releaseArchive = release.resolve;
      const archive = daemon.agentManager.archiveAgent.bind(daemon.agentManager);
      vi.spyOn(daemon.agentManager, "archiveAgent").mockImplementation(async (...args) => {
        events.push("archive-enter");
        if (scenario.cancel === "before") {
          entered.resolve();
          await release.promise;
        }
        const result = await archive(...args);
        if (scenario.cancel === "after") {
          entered.resolve();
          await release.promise;
        }
        events.push("archive-finished");
        finished.resolve();
        return result;
      });
      const controller = new AbortController();
      const pending = caller
        .callTool({ name: "archive_agent", arguments: { agentId: B } }, undefined, {
          signal: controller.signal,
        })
        .then(
          (result) => {
            events.push("response");
            return { result };
          },
          (error: Error) => {
            events.push("error");
            return { error: error.message };
          },
        );
      let atAbort: { A: boolean; B: boolean } | undefined;
      if (scenario.cancel) {
        await entered.promise;
        atAbort = { A: await archived(A), B: await archived(B) };
        events.push("client-abort");
        controller.abort();
        await pending;
        release.resolve();
      }
      const response = await pending;
      await finished.promise;
      const after = { A: await archived(A), B: await archived(B) };
      expect(after).toEqual({
        A: scenario.relation === "A-child" || scenario.relation === "self",
        B: true,
      });
      if (scenario.cancel) expect(response).toHaveProperty("error");
      else expect(response).toMatchObject({ result: { structuredContent: { success: true } } });
      if (scenario.cancel) {
        expect(atAbort).toEqual(
          scenario.cancel === "before"
            ? { A: false, B: false }
            : { A: scenario.relation === "A-child", B: true },
        );
      }
      if (scenario.relation === "A-child") {
        expect(events.indexOf("archived:B")).toBeLessThan(events.indexOf("archived:A"));
        if (!scenario.cancel) {
          expect(events.indexOf("close:A")).toBeLessThan(events.indexOf("response"));
        }
      }
      const archiveEvents = [...events];
      const storedAfter = {
        A: await daemon.agentStorage.get(A),
        B: await daemon.agentStorage.get(B),
      };
      await call(top, "send_agent_prompt", { agentId: B, prompt: "resume", notifyOnFinish: false });
      expect(await archived(B)).toBe(false);
      const afterPrompt = { A: await archived(A), B: await archived(B) };
      expect(afterPrompt).toEqual({
        A: scenario.relation === "A-child",
        B: false,
      });
      const record = {
        scenario,
        after,
        atAbort,
        response,
        archiveEvents,
        archivedAt: { A: storedAfter.A?.archivedAt, B: storedAfter.B?.archivedAt },
        afterPrompt,
      };
      await appendFile(path.join(artifactDir, "matrix.jsonl"), JSON.stringify(record) + "\n");
    } finally {
      releaseArchive?.();
      busyRelease.resolve();
      vi.restoreAllMocks();
      for (const client of connections.toReversed()) await client.close();
      await daemon.stop();
      await daemon.agentManager.flush();
      await appendFile(path.join(artifactDir, `${scenario.id}.pino.jsonl`), logs.join(""));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
