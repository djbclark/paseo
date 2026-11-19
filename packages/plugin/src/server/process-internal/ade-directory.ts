import type { ChildProcess } from "node:child_process";
import { acquireAdeDirectoryActivity, snapshotPluginActivityData } from "./activity.js";
import {
  ADE_DIRECTORY_MAX_OUTPUT,
  parseAdeDirectoryRequest,
  parseAdeDirectoryResult,
  validateAdeDirectoryInput,
  type AdeDirectoryRequest,
  type AdeDirectoryResult,
} from "../ade-directory-schema.js";

export interface PreparedAdePython {
  readonly kind: "python";
  start(): ChildProcess;
  readonly stdin: Uint8Array;
  bind(child: ChildProcess): void;
  failed(error: unknown): void;
}
export interface PreparedAdeFacts {
  readonly kind: "repository-facts";
  readonly selection: Extract<AdeDirectoryRequest, { operation: "repository-facts" }>["selection"];
  readonly stdout: Uint8Array;
  readonly status: 0 | 1;
}
export interface AdeDirectoryOperationDescriptor {
  /** Actual preparation helpers AND main helper/descendants, independent of reply/timeout. */
  readonly settled: Promise<void>;
  prepare(): Promise<PreparedAdePython | PreparedAdeFacts>;
}
export interface QualifiedAdeDirectoryAdapter {
  /** Synchronous, no launch: producer authenticates ORIGINAL realm/root/event itself. */
  acquire(
    request: AdeDirectoryRequest,
    context: Omit<ReturnType<typeof acquireAdeDirectoryActivity>, "release">,
  ): AdeDirectoryOperationDescriptor;
}
let adapter: QualifiedAdeDirectoryAdapter | undefined;
/** Fixed sealed entry only; candidate evaluator never exposes this internal namespace. */
export function installQualifiedAdeDirectoryAdapter(value: QualifiedAdeDirectoryAdapter): void {
  if (adapter) throw new Error("ADE directory adapter already installed");
  adapter = Object.freeze(value);
}

export async function executeAdeDirectoryOperation(value: unknown): Promise<AdeDirectoryResult> {
  const request = snapshotPluginActivityData(parseAdeDirectoryRequest(value));
  const current = adapter;
  if (!current) throw new Error("Qualified ADE directory producer unavailable");
  const activity = acquireAdeDirectoryActivity();
  let completed = false;
  let settled = false;
  const release = () => {
    if (completed && settled) activity.release();
  };
  try {
    // Capture descriptor and its actual-settlement promise BEFORE preparation can launch Git.
    const descriptor = current.acquire(request, {
      activityOwner: activity.activityOwner,
      root: activity.root,
      originalEvent: activity.originalEvent,
    });
    const actualSettlement = descriptor.settled;
    void actualSettlement.then(
      () => {
        settled = true;
        release();
        return undefined;
      },
      () => activity.activityOwner.markUnknown(),
    );
    const prepared = await descriptor.prepare();
    let output: Uint8Array;
    let exitCode: number;
    if (prepared.kind === "repository-facts") {
      if (
        request.operation !== "repository-facts" ||
        prepared.selection !== request.selection ||
        prepared.stdout.byteLength > 65536
      )
        throw new Error("Directory fact operation mismatch");
      output = Buffer.from(
        JSON.stringify({
          version: 1,
          selection: prepared.selection,
          status: prepared.status,
          stdout: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            prepared.stdout,
          ),
        }),
      );
      exitCode = prepared.status;
    } else {
      if (request.operation === "repository-facts")
        throw new Error("Repository facts cannot launch Python");
      const input = Uint8Array.from(prepared.stdin);
      validateAdeDirectoryInput(request, input);
      const result = await collectAdePython(prepared, input, () =>
        activity.activityOwner.markUnknown(),
      );
      output = result.output;
      exitCode = result.exitCode;
    }
    // No fact/business DATA is published before actual qualified helper settlement.
    await actualSettlement;
    return parseAdeDirectoryResult(request, output, exitCode);
  } catch (error) {
    // No generic known-failure mint: malformed/unknown execution remains held.
    activity.activityOwner.markUnknown();
    throw error;
  } finally {
    completed = true;
    release();
  }
}

function collectAdePython(
  prepared: PreparedAdePython,
  input: Uint8Array,
  unknown: () => void,
): Promise<{ output: Uint8Array; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = prepared.start();
    const chunks: Buffer[] = [];
    let length = 0;
    let stderrLength = 0;
    let failure: Error | undefined;
    const fail = (error: unknown) => {
      if (failure) return;
      failure = new Error("Qualified ADE directory execution failed");
      unknown();
      try {
        prepared.failed(error);
      } catch {
        /* Unknown remains latched; keep draining actual child. */
      }
    };
    // Attach first: even a producer bind failure must drain the ORIGINAL actual process.
    child.stdout?.on("data", (data: Buffer | string) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      length += bytes.length;
      if (length > ADE_DIRECTORY_MAX_OUTPUT) fail(new Error("Directory output overflow"));
      else if (!failure) chunks.push(bytes);
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      stderrLength += Buffer.byteLength(data);
      if (stderrLength > 4096) fail(new Error("Directory stderr overflow"));
    });
    child.once("error", fail);
    child.stdin?.once("error", fail);
    child.once("close", (code, signal) => {
      if (failure || signal || code === null)
        reject(failure ?? new Error("Directory helper failed"));
      else resolve({ output: Buffer.concat(chunks), exitCode: code });
    });
    try {
      prepared.bind(child);
    } catch (error) {
      fail(error);
    }
    // A postlaunch proof loss must not strand or rerun the ORIGINAL operation.
    // Its validated stdin is delivered once even though qualification stays UNKNOWN.
    try {
      if (!child.stdin || !child.stdout || !child.stderr)
        throw new Error("Directory stdio unavailable");
      child.stdin.end(input);
    } catch (error) {
      fail(error);
    }
  });
}
