import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { QUALIFIED_BINDING_KEYS } from "./binding-keys.js";
import type { FileIdentity } from "./types.js";
import type { DaemonManifest } from "./daemon-types.js";

declare const __QUALIFIED_DISTRIBUTION_ID__: string;
export const unsupported = (): never => {
  throw new Error("Enclosing daemon execution unsupported");
};
async function protectedPath(file: string): Promise<void> {
  if (!path.isAbsolute(file) || (await realpath(file)) !== file) return unsupported();
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (stat.uid !== 0 || stat.mode & 0o022 || stat.isSymbolicLink()) return unsupported();
    if (current === path.dirname(current)) break;
  }
}
async function bytes(file: string, maximum: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) return unsupported();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum || BigInt(total) > before.size) return unsupported();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
      if (before[key] !== after[key] || before[key] !== current[key]) return unsupported();
    }
    if (BigInt(total) !== before.size) return unsupported();
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function verifyFile(root: string, file: FileIdentity): Promise<void> {
  if (
    !file ||
    typeof file.path !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > 512 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    return unsupported();
  const target = path.isAbsolute(file.path) ? file.path : path.resolve(root, file.path);
  await protectedPath(target);
  const stat = await lstat(target);
  if (
    (stat.mode & 0o777) !== file.mode ||
    stat.size !== file.size ||
    digest(await bytes(target, file.size)) !== file.sha256
  )
    return unsupported();
}
async function enrollment(
  root: string,
): Promise<{ manifestSha256: string; distributionBuildId: string; qualificationSha256: string }> {
  const account = userInfo();
  const home = await realpath(account.homedir);
  const file = path.join(home, ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json");
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (stat.uid !== account.uid && stat.uid !== 0) || stat.mode & 0o022)
      return unsupported();
    if (current === home) break;
    if (current === path.dirname(current)) return unsupported();
  }
  const policy = JSON.parse((await bytes(file, 65536)).toString("utf8"));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.qualifications)) return unsupported();
  const rows = policy.qualifications.filter(
    (entry: { immutableRoot?: string }) => entry.immutableRoot === root,
  );
  if (rows.length !== 1 || rows[0].immutabilityAdapter !== "linux-root-owned-retained-v1")
    return unsupported();
  if (!/^[a-f0-9]{64}$/.test(rows[0].qualificationSha256)) return unsupported();
  return rows[0];
}
export async function observeLinuxProcess(pid: number) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) return unsupported();
  const executable = await realpath(`/proc/${pid}/exe`);
  const handle = await open(`/proc/${pid}/exe`, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    const disk = await lstat(executable);
    if (!actual.isFile() || actual.ino !== disk.ino || actual.dev !== disk.dev)
      return unsupported();
    return {
      pid,
      birth: `${pid}:${start}`,
      executable,
      image: `${actual.dev}:${actual.ino}:${actual.size}`,
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    };
  } finally {
    await handle.close();
  }
}
function assertManifestIdentity(
  manifest: DaemonManifest,
  expected: Awaited<ReturnType<typeof enrollment>>,
  manifestSha256: string,
): void {
  if (
    expected.manifestSha256 !== manifestSha256 ||
    expected.distributionBuildId !== __QUALIFIED_DISTRIBUTION_ID__ ||
    manifest.distributionBuildId !== __QUALIFIED_DISTRIBUTION_ID__ ||
    manifest.schemaVersion !== 2 ||
    manifest.profile !== "enclosing-daemon-v2"
  )
    return unsupported();
  if (
    manifest.entries.terminal !== "terminal-entry.mjs" ||
    manifest.entries.daemon !== "daemon.mjs" ||
    manifest.entries.pluginChild !== "plugin-child-entry.mjs" ||
    manifest.entries.compiler !== "compiler-entry.mjs" ||
    manifest.runtime.path !== "runtime/node" ||
    manifest.esbuild.path !== "runtime/esbuild"
  )
    return unsupported();
  if (JSON.stringify([...manifest.bindingKeys].sort()) !== JSON.stringify(QUALIFIED_BINDING_KEYS))
    return unsupported();
}
export async function verifyEnclosingDistribution(root: string) {
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch) ||
    process.getuid?.() === 0 ||
    process.versions.electron ||
    typeof __QUALIFIED_DISTRIBUTION_ID__ === "undefined"
  )
    return unsupported();
  await protectedPath(root);
  const expected = await enrollment(root);
  const manifestPath = `${root}.manifest.json`;
  await protectedPath(manifestPath);
  const raw = await bytes(manifestPath, 4 * 1024 * 1024);
  const manifestSha256 = digest(raw);
  const manifest = JSON.parse(raw.toString("utf8")) as DaemonManifest;
  assertManifestIdentity(manifest, expected, manifestSha256);
  const names: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await visit(file);
      else {
        if (!stat.isFile()) return unsupported();
        names.push(path.relative(root, file));
      }
    }
  }
  await visit(root);
  if (
    JSON.stringify(names.sort()) !== JSON.stringify(manifest.files.map((file) => file.path).sort())
  )
    return unsupported();
  for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split("/").includes("..")) return unsupported();
    await verifyFile(root, file);
  }
  await verifyFile(root, manifest.runtime);
  await verifyFile(root, manifest.esbuild);
  for (const file of manifest.externalLibraries) {
    if (!path.isAbsolute(file.path)) return unsupported();
    await verifyFile(root, file);
  }
  const helperInventory = [
    ...manifest.files.filter(
      (file) =>
        file.path.startsWith("runtime/") ||
        /(?:compiler|terminal)-(?:entry|code)\.mjs$/.test(file.path) ||
        file.path.endsWith(".node") ||
        file.path.endsWith("spawn-helper") ||
        file.path.startsWith("node_modules/esbuild/") ||
        file.path === "node_modules/typescript/lib/typescript.js",
    ),
    ...manifest.externalLibraries,
  ].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const helperClosureSha256 = digest(JSON.stringify(helperInventory));
  if (
    manifest.helperClosureSha256 !== helperClosureSha256 ||
    JSON.stringify(manifest.helperInventory) !== JSON.stringify(helperInventory)
  )
    return unsupported();
  return {
    root,
    manifest,
    manifestSha256,
    closure: Object.freeze({
      runtimeClosureSha256: manifestSha256,
      helperClosureSha256,
      qualificationSha256: expected.qualificationSha256,
    }),
  };
}
export async function verifyEnclosingProcess(root: string) {
  if (
    process.execArgv.length ||
    Object.keys(process.env).some((key) =>
      /^(NODE_OPTIONS|NODE_PATH|LD_.+|DYLD_.+|ELECTRON_.+)$/.test(key),
    )
  )
    return unsupported();
  if (
    process.env.ESBUILD_BINARY_PATH &&
    process.env.ESBUILD_BINARY_PATH !== path.join(root, "runtime/esbuild")
  )
    return unsupported();
  const distribution = await verifyEnclosingDistribution(root);
  const observed = await observeLinuxProcess(process.pid);
  if (observed.executable !== path.join(root, "runtime/node")) return unsupported();
  const maps = (await readFile("/proc/self/maps", "utf8")).split("\n");
  const permitted = new Set([
    observed.executable,
    ...distribution.manifest.externalLibraries.map((file) => file.path),
    ...distribution.manifest.files.map((file) => path.join(root, file.path)),
  ]);
  for (const line of maps) {
    const match = line.match(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +(\/.*)$/);
    if (match && !permitted.has(await realpath(match[1]!))) return unsupported();
  }
  return { ...distribution, observed };
}
