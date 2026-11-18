import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { observeLinuxProcess, verifyEnclosingProcess, unsupported } from "./daemon-verifier.js";
/** Scoped to the compiler Worker realm, never installed in the daemon or plugin realm. */
export async function installCompilerHelperOwner(root: string, unknown: () => void) {
  await verifyEnclosingProcess(root);
  const metadata = JSON.parse(
    await readFile(path.join(root, "node_modules/esbuild/package.json"), "utf8"),
  );
  const executable = path.join(root, "runtime/esbuild");
  const originalSpawn = childProcess.spawn;
  const children = new Map<ChildProcess, Promise<void>>();
  const observations = new Set<Promise<void>>();
  const identities = new Map<ChildProcess, Awaited<ReturnType<typeof observeLinuxProcess>>>();
  let failed = false;
  function hold(): void {
    failed = true;
    unknown();
  }
  function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess {
    if (
      failed ||
      command !== executable ||
      !Array.isArray(args) ||
      args[0] !== `--service=${metadata.version}` ||
      args.length > 2 ||
      (args.length === 2 && args[1] !== "--ping")
    )
      return unsupported();
    const child = originalSpawn(command, [...args], {
      ...options,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      detached: false,
    });
    children.set(
      child,
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("error", hold);
      }),
    );
    const observed = observeLinuxProcess(child.pid!)
      .then((actual) => {
        if (actual.executable !== executable) return unsupported();
        identities.set(child, actual);
      })
      .catch(hold)
      .finally(() => {
        observations.delete(observed);
      });
    observations.add(observed);
    return child;
  }
  Reflect.set(childProcess, "spawn", spawn);
  for (const name of ["exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"])
    Reflect.set(childProcess, name, () => unsupported());
  syncBuiltinESMExports();
  return Object.freeze({
    async settled(): Promise<void> {
      await Promise.all(observations);
      for (const [child, expected] of identities) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const actual = await observeLinuxProcess(child.pid!);
        if (
          actual.birth !== expected.birth ||
          actual.image !== expected.image ||
          actual.executable !== executable
        ) {
          hold();
          return unsupported();
        }
      }
      if (failed) return unsupported();
    },
    async stop(): Promise<void> {
      const require = createRequire(path.join(root, "compiler-code.mjs"));
      const esbuild = require("esbuild") as { stop(): void };
      esbuild.stop();
      await Promise.all(children.values());
      await Promise.all(observations);
      if (failed) return unsupported();
    },
  });
}
