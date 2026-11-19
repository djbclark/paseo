import { parentPort } from "node:worker_threads";
import { z, type ZodIssue } from "zod";
import { compilePlugin, compileDirectoryPlugin } from "./compiler-build.js";
import { runPluginBuild } from "./preparation-build.js";
import type { CompilerTask } from "./compiler.js";

export type CompilerReply =
  | { kind: "log"; data: Record<string, unknown>; message: string }
  | { kind: "result"; value: unknown }
  | {
      kind: "error";
      error: Error;
      properties: Record<string, unknown>;
      issues?: ZodIssue[];
      errors?: unknown[];
      warnings?: unknown[];
    };

// DATA shape only. Genuine original local producer admission is not implemented yet.
const selectedDirectoryTask = z
  .object({
    kind: z.literal("directory-selected"),
    directory: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

const port = parentPort!;
const admittedTasks = new Set<Promise<void>>();
let retirement: Promise<void> | undefined;
let acceptingTasks = true;

// Closing ingress is synchronous: the qualified producer seals helper admission
// immediately after this call, then awaits actual tasks before stopping esbuild.
export function retireQualifiedCompilerTasks(): Promise<void> {
  acceptingTasks = false;
  retirement ??= Promise.allSettled(admittedTasks).then(() => undefined);
  return retirement;
}
// The compiler owner serializes requests; the port queues the first request
// until this entrypoint has loaded, including in source/tsx development.
port.on("message", (task: CompilerTask) => {
  if (!acceptingTasks) {
    port.postMessage({
      kind: "error",
      error: new Error("Plugin compiler is retiring"),
      properties: {},
    } satisfies CompilerReply);
    return;
  }
  const pending = run(task);
  admittedTasks.add(pending);
  void pending.then(
    () => admittedTasks.delete(pending),
    () => admittedTasks.delete(pending),
  );
});

async function run(task: CompilerTask): Promise<void> {
  try {
    let value: unknown;
    switch (task.kind) {
      case "entries":
        value = await compilePlugin(task.entries);
        break;
      case "directory":
        value = await compileDirectoryPlugin(task.directory, task.version, task.builtinId);
        break;
      case "directory-selected":
        selectedDirectoryTask.parse(task);
        throw new Error("Selected directory compiler admission unavailable");
      case "prepare":
        await runPluginBuild(
          task.directory,
          task.commands,
          {
            info: (data, message) =>
              port.postMessage({ kind: "log", data, message } satisfies CompilerReply),
          },
          task.environment,
        );
        break;
    }
    port.postMessage({ kind: "result", value } satisfies CompilerReply);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    port.postMessage({
      kind: "error",
      error,
      // Error cloning drops own metadata such as filesystem code/path. Zod's
      // readonly issues are reconstructed separately by the compiler owner.
      properties: Object.fromEntries(Object.entries(error).filter(([key]) => key !== "issues")),
      ...("issues" in error ? { issues: error.issues as ZodIssue[] } : {}),
      ...("errors" in error ? { errors: error.errors as unknown[] } : {}),
      ...("warnings" in error ? { warnings: error.warnings as unknown[] } : {}),
    } satisfies CompilerReply);
  }
}
