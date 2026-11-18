import { verifySystemClosure, verifySystemMappings } from "./system-closure.js";
import { readBuiltinProfiles } from "./builtin-profile.js";
import { canonicalBuiltinJson } from "./builtin-format.js";
import builtinBindingsRecipe from "./builtin-bindings-recipe.json" with { type: "json" };
import builtinPlugins from "./builtin-inventory.json" with { type: "json" };
import { readFixedManagedPluginPolicy } from "./managed-policy-environment.js";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  realpathSync,
} from "node:fs";
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
async function snapshotBytes(
  file: string,
  maximum: number,
): Promise<{ data: Buffer; identity: string }> {
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
    return {
      data: Buffer.concat(chunks),
      identity: [
        before.dev,
        before.ino,
        before.mode,
        before.uid,
        before.gid,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ]
        .map(String)
        .join(":"),
    };
  } finally {
    await handle.close();
  }
}
async function bytes(file: string, maximum: number): Promise<Buffer> {
  return (await snapshotBytes(file, maximum)).data;
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
async function enrollment(root: string): Promise<{
  manifestSha256: string;
  distributionBuildId: string;
  qualificationSha256: string;
  authorityIdentity: string;
  builtinProfiles?: unknown;
}> {
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
  const snapshot = await snapshotBytes(file, 65536);
  const policy = JSON.parse(snapshot.data.toString("utf8"));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.qualifications)) return unsupported();
  const rows = policy.qualifications.filter(
    (entry: { immutableRoot?: string }) => entry.immutableRoot === root,
  );
  if (rows.length !== 1 || rows[0].immutabilityAdapter !== "linux-root-owned-retained-v1")
    return unsupported();
  if (!/^[a-f0-9]{64}$/.test(rows[0].qualificationSha256)) return unsupported();
  return { ...rows[0], authorityIdentity: `${snapshot.identity}:${digest(snapshot.data)}` };
}
/** Final authority CAS after every awaited observation; never a source of capability. */
export async function assertEnclosingAuthorityUnchanged(observed: {
  root: string;
  authorityIdentity: string;
}): Promise<void> {
  const current = await enrollment(observed.root);
  if (current.authorityIdentity !== observed.authorityIdentity) return unsupported();
}
/** Bounded final CAS for the SDK's synchronous ChildProcess launch contract. */
export function assertEnclosingAuthorityUnchangedSync(observed: {
  root: string;
  authorityIdentity: string;
}): void {
  const account = userInfo(),
    home = realpathSync(account.homedir);
  const file = path.join(home, ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json");
  for (let current = file; ; current = path.dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (info.uid !== account.uid && info.uid !== 0) || info.mode & 0o022)
      return unsupported();
    if (current === home) break;
    if (current === path.dirname(current)) return unsupported();
  }
  if (snapshotAuthoritySync(file) !== observed.authorityIdentity) return unsupported();
}
function snapshotAuthoritySync(file: string): string {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 65536n) return unsupported();
    const buffer = Buffer.alloc(65537);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
      if (total > 65536 || BigInt(total) > before.size) return unsupported();
    }
    const after = fstatSync(descriptor, { bigint: true }),
      current = lstatSync(file, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ] as const)
      if (before[key] !== after[key] || before[key] !== current[key]) return unsupported();
    const identity = [
      before.dev,
      before.ino,
      before.mode,
      before.uid,
      before.gid,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]
      .map(String)
      .join(":");
    if (BigInt(total) !== before.size) return unsupported();
    return `${identity}:${digest(buffer.subarray(0, total))}`;
  } finally {
    closeSync(descriptor);
  }
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
  if (JSON.stringify(manifest.builtinPlugins) !== JSON.stringify(builtinPlugins))
    return unsupported();
  if (JSON.stringify([...manifest.bindingKeys].sort()) !== JSON.stringify(QUALIFIED_BINDING_KEYS))
    return unsupported();
}
function assertBuiltinModuleTable(manifest: DaemonManifest): void {
  const expectedTable = {
    schemaVersion: 1,
    recipe: builtinBindingsRecipe,
    runtimeSha256: manifest.runtime.sha256,
    daemonSha256: manifest.files.find((file) => file.path === "daemon.mjs")?.sha256,
    externalLibraries: manifest.externalLibraries,
    systemClosureSha256: manifest.systemClosureSha256,
  };
  if (
    JSON.stringify(manifest.builtinModuleTable) !== JSON.stringify(expectedTable) ||
    manifest.moduleTableSha256 !== digest(canonicalBuiltinJson(expectedTable))
  )
    return unsupported();
}
function assertBuiltinArtifacts(manifest: DaemonManifest): void {
  assertBuiltinModuleTable(manifest);
  if (
    !Array.isArray(manifest.builtinArtifacts) ||
    JSON.stringify(manifest.builtinArtifacts.map((row) => row.id)) !==
      JSON.stringify(builtinPlugins)
  )
    return unsupported();
  for (const row of manifest.builtinArtifacts) {
    const prefix = `builtin-compiled/${row.id}`;
    if (
      row.factoryPath !== `${prefix}/server.factory.js` ||
      row.manifestPath !== `${prefix}/manifest.json` ||
      row.metafilePath !== `${prefix}/metafile.json` ||
      row.sourceIdentityPath !== `${prefix}/source-identity.json` ||
      row.moduleTableSha256 !== manifest.moduleTableSha256 ||
      !/^[a-f0-9]{64}$/.test(row.sourceSha256) ||
      !Array.isArray(row.moduleImports)
    )
      return unsupported();
    const factory = manifest.files.find((file) => file.path === row.factoryPath);
    const original = manifest.files.find((file) => file.path === `${prefix}/server-original.js`);
    if (
      !factory ||
      factory.sha256 !== row.serverBundleSha256 ||
      !original ||
      original.sha256 !== row.originalServerBundleSha256 ||
      !manifest.files.some((file) => file.path === row.manifestPath) ||
      !manifest.files.some((file) => file.path === row.metafilePath) ||
      !manifest.files.some(
        (file) => file.path === row.sourceIdentityPath && file.sha256 === row.sourceSha256,
      )
    )
      return unsupported();
  }
}
async function assertBuiltinInventory(root: string, names: string[]): Promise<void> {
  const builtinDirectories = (
    await readdir(path.join(root, "builtin-plugins"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(builtinDirectories) !== JSON.stringify(builtinPlugins)) return unsupported();
  for (const id of builtinPlugins)
    if (!names.includes(`builtin-plugins/${id}/paseo-plugin.json`)) return unsupported();
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
  assertBuiltinArtifacts(manifest);
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
  await assertBuiltinInventory(root, names);
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
        file.path.startsWith("system-closure/") ||
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
  await verifySystemClosure(root, manifest);
  await assertEnclosingAuthorityUnchanged({ root, authorityIdentity: expected.authorityIdentity });
  return {
    root,
    manifest,
    manifestSha256,
    authorityIdentity: expected.authorityIdentity,
    builtinProfiles: readBuiltinProfiles(expected.builtinProfiles),
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
      /^(NODE_OPTIONS|NODE_PATH|GLIBC_TUNABLES|LD_.+|DYLD_.+|ELECTRON_.+)$/.test(key),
    )
  )
    return unsupported();
  if (
    process.env.ESBUILD_BINARY_PATH &&
    process.env.ESBUILD_BINARY_PATH !== path.join(root, "runtime/esbuild")
  )
    return unsupported();
  const managedPolicy = await readFixedManagedPluginPolicy();
  if (process.env.PASEO_MANAGED_PLUGIN_POLICY !== managedPolicy.path) return unsupported();
  const distribution = await verifyEnclosingDistribution(root);
  const observed = await observeLinuxProcess(process.pid);
  if (observed.executable !== path.join(root, "runtime/node")) return unsupported();
  const systemObservation = await verifySystemMappings(root, distribution.manifest, process.pid);
  await assertEnclosingAuthorityUnchanged(distribution);
  return { ...distribution, observed, systemObservation };
}
