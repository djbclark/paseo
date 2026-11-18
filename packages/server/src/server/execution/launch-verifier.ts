import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { linuxRetainedRoot } from "./retained-root.js";
import { QUALIFIED_BINDING_KEYS } from "./binding-keys.js";
import type { FileIdentity, HostManifest } from "./types.js";

declare const __QUALIFIED_DISTRIBUTION_ID__: string;
declare const __QUALIFIED_ROLE_ID__: string;
const fail = (): never => {
  throw new Error("Qualified execution unsupported");
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function regular(file: string, maximum: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) return fail();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maximum - size + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > maximum || BigInt(size) > before.size) return fail();
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
      if (before[key] !== after[key] || before[key] !== current[key]) return fail();
    }
    if (BigInt(size) !== before.size) return fail();
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}
function verifyFile(root: string, expected: FileIdentity): void {
  if (
    !expected ||
    typeof expected.path !== "string" ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > 512 * 1024 * 1024
  )
    return fail();
  const file = path.isAbsolute(expected.path) ? expected.path : path.resolve(root, expected.path);
  linuxRetainedRoot.verifyPath(file);
  const stat = lstatSync(file);
  if (
    stat.size !== expected.size ||
    (stat.mode & 0o777) !== expected.mode ||
    digest(regular(file, expected.size)) !== expected.sha256
  )
    return fail();
}
export function mappedLibraries(): string[] {
  return [
    ...new Set(
      readFileSync("/proc/self/maps", "utf8")
        .split("\n")
        .flatMap((line) => {
          const match = line.match(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +(\/.*)$/);
          if (!match) return [];
          if (match[1]!.endsWith(" (deleted)")) return fail();
          return [realpathSync(match[1]!)];
        }),
    ),
  ].sort();
}
export function processIdentity(): {
  bootId: string;
  osBirthIdentity: string;
  executable: string;
  executableIdentity: string;
} {
  const text = readFileSync("/proc/self/stat", "utf8");
  const start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) return fail();
  const executable = realpathSync("/proc/self/exe");
  // This one kernel-owned link deliberately follows the executing image, not a
  // caller-selected symlink. Compare its descriptor with the immutable pathname.
  const fd = openSync("/proc/self/exe", constants.O_RDONLY | constants.O_NONBLOCK);
  let executableIdentity: string;
  try {
    const actual = fstatSync(fd);
    const disk = lstatSync(executable);
    if (!actual.isFile() || actual.dev !== disk.dev || actual.ino !== disk.ino) return fail();
    executableIdentity = `${actual.dev}:${actual.ino}:${actual.size}`;
  } finally {
    closeSync(fd);
  }
  return {
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    osBirthIdentity: `${process.pid}:${start}`,
    executable,
    executableIdentity,
  };
}
export function verifyQualifiedRoot(root: string): {
  manifest: HostManifest;
  manifestSha256: string;
  root: string;
} {
  if (process.platform !== "linux" || process.getuid?.() === 0) return fail();
  linuxRetainedRoot.verifyPath(root);
  const account = userInfo();
  const authority = path.join(
    realpathSync(account.homedir),
    ".local/state/djbclark-ade/forks/paseo-qualified-host-policy.json",
  );
  for (let directory = path.dirname(authority); ; directory = path.dirname(directory)) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== account.uid && stat.uid !== 0) ||
      stat.mode & 0o022
    )
      return fail();
    if (directory === account.homedir || directory === path.dirname(directory)) break;
  }
  const authorityStat = lstatSync(authority);
  if ((authorityStat.uid !== account.uid && authorityStat.uid !== 0) || authorityStat.mode & 0o022)
    return fail();
  const policy = JSON.parse(regular(authority, 65536).toString("utf8"));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.qualifications)) return fail();
  const enrolled = policy.qualifications.filter(
    (entry: { immutableRoot?: string }) => entry.immutableRoot === root,
  );
  if (enrolled.length !== 1) return fail();
  const expected = enrolled[0];
  if (expected.immutabilityAdapter !== linuxRetainedRoot.kind) return fail();
  const manifestPath = `${root}.manifest.json`;
  linuxRetainedRoot.verifyPath(manifestPath);
  const raw = regular(manifestPath, 1024 * 1024);
  const manifestSha256 = digest(raw);
  const manifest = JSON.parse(raw.toString("utf8")) as HostManifest;
  if (
    expected.manifestSha256 !== manifestSha256 ||
    expected.distributionBuildId !== manifest.distributionBuildId ||
    expected.roleBuildId !== manifest.roleBuildId ||
    manifest.schemaVersion !== 1 ||
    manifest.role !== "plugin-host" ||
    !Array.isArray(manifest.helpers) ||
    manifest.helpers.length ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.externalLibraries) ||
    !Array.isArray(manifest.bindingKeys)
  )
    return fail();
  if (JSON.stringify([...manifest.bindingKeys].sort()) !== JSON.stringify(QUALIFIED_BINDING_KEYS))
    return fail();
  const names: string[] = [];
  function visit(directory: string): void {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        if (!stat.isFile()) return fail();
        names.push(path.relative(root, file));
      }
    }
  }
  visit(root);
  if (
    JSON.stringify(names.sort()) !==
      JSON.stringify(manifest.files.map((file) => file.path).sort()) ||
    new Set(names).size !== manifest.files.length
  )
    return fail();
  for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split("/").includes("..")) return fail();
    verifyFile(root, file);
  }
  if (manifest.runtime.path !== "runtime/node") return fail();
  verifyFile(root, manifest.runtime);
  for (const file of manifest.externalLibraries) {
    if (!path.isAbsolute(file.path)) return fail();
    verifyFile(root, file);
  }
  return { manifest, manifestSha256, root };
}
export function verifyQualifiedLaunch(
  roleFile: string,
): ReturnType<typeof verifyQualifiedRoot> & { process: ReturnType<typeof processIdentity> } {
  if (
    process.platform !== "linux" ||
    process.versions.electron ||
    typeof __QUALIFIED_DISTRIBUTION_ID__ === "undefined" ||
    typeof __QUALIFIED_ROLE_ID__ === "undefined" ||
    process.execArgv.length
  )
    return fail();
  if (
    Object.keys(process.env).some((key) =>
      /^(NODE_OPTIONS|NODE_PATH|ESBUILD_BINARY_PATH|LD_.+|DYLD_.+|ELECTRON_.+)$/.test(key),
    )
  )
    return fail();
  const root = path.dirname(roleFile);
  if (realpathSync(process.argv[1] ?? "") !== path.join(root, "role.cjs")) return fail();
  const qualified = verifyQualifiedRoot(root);
  const { manifest } = qualified;
  if (
    manifest.distributionBuildId !== __QUALIFIED_DISTRIBUTION_ID__ ||
    manifest.roleBuildId !== __QUALIFIED_ROLE_ID__
  )
    return fail();
  const observed = processIdentity();
  if (observed.executable !== path.resolve(root, manifest.runtime.path)) return fail();
  const libraries = mappedLibraries().filter((file) => file !== observed.executable);
  if (
    JSON.stringify(libraries) !==
    JSON.stringify(manifest.externalLibraries.map((file) => file.path).sort())
  )
    return fail();
  return { ...qualified, process: observed };
}
