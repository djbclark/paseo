import type { ChildProcess } from "node:child_process";
import { getSystemErrorName } from "node:util";
import type { PluginBuiltinExecFileLaunch, PluginHelperOperation } from "./activity.js";

type ExecOutput = string | Buffer;
type ExecCallback = (error: Error | null, stdout: ExecOutput, stderr: ExecOutput) => void;

/** The fixed worktree Git adapter's bounded execFile output surface, not a launcher registry. */
export function collectBuiltinExecFile(
  launch: PluginBuiltinExecFileLaunch,
  operation: PluginHelperOperation,
  callback: ExecCallback | undefined,
): ChildProcess {
  const maxBuffer = operation.options.maxBuffer ?? 1024 * 1024;
  if (typeof maxBuffer !== "number" || maxBuffer < 0 || Number.isNaN(maxBuffer))
    throw new RangeError("options.maxBuffer must be a nonnegative number");
  const encoding = operation.options.encoding === undefined ? "utf8" : operation.options.encoding;
  const outputEncoding =
    encoding && Buffer.isEncoding(encoding) ? (encoding as BufferEncoding) : null;
  const child = launch.start();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let failure: Error | null = null;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  const cmd = [operation.command, ...operation.args].join(" ");
  const kill = () => {
    killed = true;
    // This preserves the caller's existing execFile timeout/maxBuffer semantics.
    // Maintenance itself never invokes it, and it cannot settle the producer permit.
    child.kill(operation.options.killSignal ?? "SIGTERM");
  };
  const output = (chunks: Buffer[]): ExecOutput => {
    const bytes = Buffer.concat(chunks);
    return outputEncoding ? bytes.toString(outputEncoding) : bytes;
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (complete) return;
    complete = true;
    if (timer) clearTimeout(timer);
    if (!failure) failure = readInnerExecFailure(launch, operation);
    if (!failure && (code !== 0 || signal))
      failure = Object.assign(new Error(`Command failed: ${cmd}\n${output(stderr).toString()}`), {
        code,
        signal,
        killed,
        cmd,
      });
    if (failure) Object.assign(failure, { cmd });
    callback?.(failure, output(stdout), output(stderr));
  };
  const observe = (stream: ChildProcess["stdout"], chunks: Buffer[], name: string) => {
    let length = 0;
    stream?.on("data", (data: Buffer | string) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const remaining = Math.max(0, maxBuffer - length);
      length += bytes.length;
      chunks.push(bytes.subarray(0, remaining));
      if (length > maxBuffer) {
        failure = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
        kill();
      }
    });
  };
  observe(child.stdout, stdout, "stdout");
  observe(child.stderr, stderr, "stderr");
  child.once("error", (error: Error) => {
    failure = error;
    // A spawn error still has an actual close event; it is not permit settlement.
  });
  child.once("close", finish);
  if (operation.options.timeout && operation.options.timeout > 0)
    timer = setTimeout(kill, operation.options.timeout);
  return child;
}

export function builtinExecCallback(args: readonly unknown[]): ExecCallback | undefined {
  const last = args.at(-1);
  return typeof last === "function"
    ? (error, stdout, stderr) => {
        Reflect.apply(last, undefined, [error, stdout, stderr]);
      }
    : undefined;
}

/** Read only after the real carrier closes; a numeric Git exit is otherwise untouched. */
function readInnerExecFailure(
  launch: PluginBuiltinExecFileLaunch,
  operation: PluginHelperOperation,
): Error | null {
  try {
    const failure = launch.readExecFailure?.();
    if (!failure) return null;
    if (
      !Number.isSafeInteger(failure.errno) ||
      failure.errno <= 0 ||
      (failure.syscall !== "execveat" && failure.syscall !== "execvp")
    )
      throw new Error("Invalid private builtin exec failure");
    const errno = -failure.errno;
    const code = getSystemErrorName(errno);
    const syscall = `spawn ${operation.command}`;
    return Object.assign(new Error(`${syscall} ${code}`), {
      errno,
      code,
      syscall,
      path: operation.command,
      spawnargs: [...operation.args],
    });
  } catch (error) {
    return error instanceof Error ? error : new Error("Private builtin exec failure unavailable");
  }
}
