import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { extname } from "node:path";
import { acquirePluginHelper } from "./process-internal/activity.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./process-internal/windows-command.js";
export interface ExecCommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}
interface ExecCommandResult {
  stdout: string;
  stderr: string;
}
function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

/** Launch a CLI with Windows command-script handling and argv quoting. The caller owns env. */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: "pipe" },
): ChildProcessWithoutNullStreams;
export function spawnProcess(command: string, args: string[], options?: SpawnOptions): ChildProcess;
export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  const spawnOptions = options ?? {};
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);

  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;

  const release = acquirePluginHelper();
  try {
    const child = spawn(resolvedCommand, resolvedArgs, {
      ...spawnOptions,
      env: options?.env,
      shell,
      signal: options?.signal,
      windowsHide: true,
    });
    child.once("close", release);
    return child;
  } catch (error) {
    release();
    throw error;
  }
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const isWindows = process.platform === "win32";
  const shell = shouldUseWindowsShell(command, options?.shell);
  const shouldQuoteForShell = isWindows && shell !== false;
  const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
  const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;

  const release = acquirePluginHelper();
  return new Promise<ExecCommandResult>((resolve, reject) => {
    try {
      const child = execFile(
        resolvedCommand,
        resolvedArgs,
        {
          cwd: options?.cwd,
          env: options?.env,
          encoding: options?.encoding ?? "utf8",
          signal: options?.signal,
          killSignal: options?.killSignal,
          timeout: options?.timeout,
          maxBuffer: options?.maxBuffer,
          shell,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            Object.assign(error, { stdout, stderr });
            reject(error);
          } else resolve({ stdout, stderr });
        },
      );
      child.once("close", release);
    } catch (error) {
      release();
      reject(error);
    }
  });
}

/** Force-stop a CLI, including descendants behind Windows command-script launchers. */
export async function terminateProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  if (process.platform !== "win32") {
    child.kill(signal);
    return;
  }
  if (child.pid === undefined) return;
  try {
    await execCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      timeout: 5000,
    });
  } catch (error) {
    // The process can finish between its close check and taskkill.
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}
