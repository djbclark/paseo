import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentMaintenanceExecution } from "../server/maintenance-reservation.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnProcess as spawnCli, execCommand as execCli } from "@getpaseo/plugin/server";
import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/paseo-env.js";

const execFileWithChild = promisify(execFile);

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
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

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const reservation = currentMaintenanceExecution();
  const release = reservation?.enterProcess();
  try {
    const spawn = () => spawnCli(command, args, { ...spawnOptions, env: childEnv, signal: options?.signal });
    const child = reservation && release ? reservation.executeAdmitted(release, spawn) : spawn();
    child.once("close", () => release?.());
    return child;
  } catch (error) { release?.(); throw error; }
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const reservation = currentMaintenanceExecution();
  if (reservation && process.platform !== "win32") {
    const release = reservation.enterProcess();
    let attached = false;
    try {
      // Keep the child lease beyond an AbortError/timeout callback until actual close.
      const running = reservation.executeAdmitted(release, () => execFileWithChild(command, args, {
        cwd: options?.cwd, env: childEnv, shell: options?.shell,
        encoding: options?.encoding ?? "utf8", signal: options?.signal,
        killSignal: options?.killSignal, timeout: options?.timeout, maxBuffer: options?.maxBuffer,
      })) as Promise<ExecCommandResult> & { child: ChildProcess };
      running.child.once("close", release);
      attached = true;
      return await running;
    } catch (error) {
      if (!attached) release();
      throw error;
    }
  }
  const execute = () => execCli(command, args, {
    cwd: options?.cwd,
    env: childEnv,
    shell: options?.shell,
    encoding: options?.encoding ?? "utf8",
    signal: options?.signal,
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
  }) as Promise<ExecCommandResult>;
  return reservation ? reservation.run(execute) : execute();
}
