import { z } from "zod";
import { constants } from "node:fs";
import { open, lstat, realpath, readFile, readlink, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalBuiltinJson } from "./builtin-format.js";
import { describeElf, describeLoaderCache, isTargetElf } from "./elf-format.js";
import type { FileIdentity } from "./types.js";
const Text = z.string().min(1).max(4096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = {
  mode: z.union([z.literal(292), z.literal(365)]),
  size: z.number().int().nonnegative().max(536870912),
  sha256: Digest,
};
export const RetainedExternalSchema = z
  .object({ path: Text, retainedPath: Text, ...Identity })
  .strict();
const Elf = z
  .object({
    member: Text,
    machine: z.union([z.literal(62), z.literal(183)]),
    interpreter: Text.nullable(),
    needed: z.array(Text).max(128),
    rpath: z.array(Text).max(128),
    runpath: z.array(Text).max(128),
    soname: Text.nullable(),
  })
  .strict();
export const SystemClosureSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.literal("linux-retained-system-closure-v1"),
    loaderResolution: z
      .object({
        schemaVersion: z.literal(1),
        policy: z.literal("glibc-pinned-cache-existing-layout-v1"),
        elf: z.array(Elf).max(512),
        interpreters: z.array(z.object({ request: Text, target: Text }).strict()).max(32),
        aliases: z.array(z.object({ path: Text, target: Text, linkText: Text }).strict()).max(512),
        searchDirectories: z
          .array(z.object({ kind: z.enum(["system", "retained"]), path: Text }).strict())
          .max(64),
        hwcaps: z.object({ policy: z.literal("no-relevant-hwcaps-v1") }).strict(),
        cache: z
          .object({
            path: z.literal("/etc/ld.so.cache"),
            retainedPath: z.literal("system-closure/loader/ld.so.cache"),
            mode: z.literal(292),
            size: z.number().int().nonnegative().max(16777216),
            sha256: Digest,
            entries: z
              .array(
                z
                  .object({
                    soname: Text,
                    path: Text,
                    target: Text,
                    flags: z.number().int(),
                    hwcap: z.literal("0"),
                  })
                  .strict(),
              )
              .max(2048),
          })
          .strict(),
        preload: z
          .object({ path: z.literal("/etc/ld.so.preload"), state: z.literal("absent") })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type SystemClosure = z.infer<typeof SystemClosureSchema>;
export type RetainedExternal = z.infer<typeof RetainedExternalSchema>;
interface ClosureManifest {
  files: FileIdentity[];
  externalLibraries: RetainedExternal[];
  systemClosure: SystemClosure;
  systemClosureSha256: string;
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("Retained system closure unsupported");
};
function safePath(value: string, absolute: boolean): void {
  if (
    !value ||
    value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    path.posix.isAbsolute(value) !== absolute ||
    path.posix.normalize(value) !== value ||
    value.split("/").includes("..") ||
    value.split("/").includes(".")
  )
    fail();
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail();
}
function same(a: unknown, b: unknown): boolean {
  return canonicalBuiltinJson(a) === canonicalBuiltinJson(b);
}
async function sourceBytes(file: string, expected: FileIdentity) {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > 536870912)
    return fail();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      before.mode & 0o022n ||
      before.size !== BigInt(expected.size) ||
      (Number(before.mode) & 0o777) !== expected.mode
    )
      return fail();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
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
      if (before[key] !== after[key]) return fail();
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) return fail();
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}
function metadata(manifest: ClosureManifest) {
  const closure = SystemClosureSchema.parse(manifest.systemClosure);
  if (hash(canonicalBuiltinJson(closure)) !== manifest.systemClosureSha256) return fail();
  const external = z.array(RetainedExternalSchema).max(128).parse(manifest.externalLibraries);
  unique(external.map((row) => row.path));
  unique(external.map((row) => row.retainedPath));
  let total = 0;
  for (const row of external) {
    safePath(row.path, true);
    safePath(row.retainedPath, false);
    if (row.retainedPath !== `system-closure/elf/${row.path.slice(1)}`) fail();
    total += row.size;
    if (total > 536870912) fail();
  }
  const layout = closure.loaderResolution;
  unique(layout.elf.map((row) => row.member));
  unique(layout.interpreters.map((row) => row.request));
  unique(layout.aliases.map((row) => row.path));
  unique(layout.searchDirectories.map((row) => `${row.kind}:${row.path}`));
  for (const row of layout.elf) safePath(row.member, false);
  for (const row of layout.interpreters) {
    safePath(row.request, true);
    safePath(row.target, true);
    if (!external.some((item) => item.path === row.target && item.mode === 0o555)) fail();
  }
  for (const row of layout.searchDirectories) safePath(row.path, row.kind === "system");
  for (const row of layout.aliases) {
    safePath(row.path, true);
    safePath(row.target, true);
    if (
      row.linkText.includes("\0") ||
      (!external.some((item) => item.path === row.target) &&
        !layout.searchDirectories.some(
          (item) => item.kind === "system" && item.path === row.target,
        ))
    )
      fail();
  }
  for (const row of [...external, layout.cache]) {
    const file = manifest.files.find((item) => item.path === row.retainedPath);
    if (!file || file.mode !== row.mode || file.size !== row.size || file.sha256 !== row.sha256)
      fail();
  }
  return { closure, external };
}
/** Structural evidence validation only; never mints an owner or approves a namespace. */
export function assertSystemClosureMetadata(manifest: ClosureManifest): void {
  metadata(manifest);
}
async function verifyAliasLayout(closure: SystemClosure): Promise<void> {
  const layout = closure.loaderResolution;
  for (const row of layout.aliases) {
    const stat = await lstat(row.path);
    if (
      !stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (await readlink(row.path)) !== row.linkText ||
      (await realpath(row.path)) !== row.target
    )
      fail();
  }
  try {
    await lstat(layout.preload.path);
    return fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Requires the already-sealed readonly namespace view; no host-library fallback. */
export async function verifySystemClosure(root: string, manifest: ClosureManifest): Promise<void> {
  const { closure, external } = metadata(manifest);
  const layout = closure.loaderResolution;
  await verifyAliasLayout(closure);
  const interpreterRequests = [
    ...new Set(
      layout.elf.map((row) => row.interpreter).filter((value): value is string => value !== null),
    ),
  ].sort();
  if (!same(interpreterRequests, layout.interpreters.map((row) => row.request).sort()))
    return fail();
  for (const row of layout.interpreters)
    if ((await realpath(row.request)) !== row.target) return fail();
  const machine = process.arch === "x64" ? 62 : 183;
  await verifyArtifactElfs(root, manifest, closure);
  for (const row of external) {
    const backing = await sourceBytes(path.join(root, row.retainedPath), {
      ...row,
      path: row.retainedPath,
    });
    const actual = await sourceBytes(row.path, row);
    if (backing.stat.dev !== actual.stat.dev || backing.stat.ino !== actual.stat.ino) return fail();
  }
  const cache = layout.cache;
  const stored = await sourceBytes(path.join(root, cache.retainedPath), {
    ...cache,
    path: cache.retainedPath,
  });
  const actual = await sourceBytes(cache.path, cache);
  if (stored.stat.dev !== actual.stat.dev || stored.stat.ino !== actual.stat.ino) return fail();
  const needed = new Set(layout.elf.flatMap((row) => row.needed));
  const entries = describeLoaderCache(stored.bytes, machine).filter((row) =>
    needed.has(row.soname),
  );
  const actualEntries = [];
  for (const row of entries) {
    if (row.hwcap !== "0") return fail();
    const target = await realpath(row.path);
    actualEntries.push({ ...row, target });
    if (!external.some((item) => item.path === target) && !target.startsWith(`${root}/`))
      return fail();
  }
  const key = (row: { soname: string; path: string; flags: number }) =>
    `${row.soname}:${row.path}:${row.flags}`;
  actualEntries.sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  if (!same(actualEntries, cache.entries)) return fail();
  await lookupInputs(root, manifest);
  await verifySearchDirectories(root, manifest);
}
async function verifyArtifactElfs(
  root: string,
  manifest: ClosureManifest,
  closure: SystemClosure,
): Promise<void> {
  const layout = closure.loaderResolution;
  const machine = process.arch === "x64" ? 62 : 183;
  const declared = new Map(layout.elf.map((row) => [row.member, row]));
  for (const file of manifest.files) {
    const handle = await open(
      path.join(root, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let target = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return fail();
      const prefix = Buffer.alloc(64);
      const { bytesRead } = await handle.read(prefix, 0, 64, 0);
      target = isTargetElf(prefix.subarray(0, bytesRead), machine);
    } finally {
      await handle.close();
    }
    if (!target) {
      if (declared.has(file.path)) return fail();
      continue;
    }
    const row = declared.get(file.path);
    if (!row) return fail();
    const { bytes } = await sourceBytes(path.join(root, file.path), file);
    if (
      !same(row, { member: file.path, ...describeElf(bytes) }) ||
      row.needed.some((value) => value.includes("/") || value.includes("\0"))
    )
      return fail();
    declared.delete(file.path);
  }
  if (declared.size) return fail();
}
async function lookupInputs(root: string, manifest: ClosureManifest): Promise<void> {
  const layout = manifest.systemClosure.loaderResolution;
  const expectedAliases = new Map<string, { path: string; target: string; linkText: string }>();
  const activeAliases = new Set<string>();
  async function aliases(file: string): Promise<void> {
    let current = "/",
      sawLink = false;
    for (const component of file.split("/").filter(Boolean)) {
      if (component === ".") continue;
      if (component === "..") {
        if (sawLink) return fail();
        current = path.dirname(current);
        continue;
      }
      current = path.join(current, component);
      const stat = await lstat(current);
      if (!stat.isSymbolicLink()) {
        if (stat.uid !== 0 || stat.mode & 0o022) return fail();
        continue;
      }
      if (stat.uid !== 0 || activeAliases.has(current) || activeAliases.size >= 32) return fail();
      activeAliases.add(current);
      sawLink = true;
      const linkText = await readlink(current);
      expectedAliases.set(current, { path: current, target: await realpath(current), linkText });
      const parent = await realpath(path.dirname(current));
      await aliases(linkText.startsWith("/") ? linkText : `${parent}/${linkText}`);
      activeAliases.delete(current);
    }
  }
  let selectionEntries = 0;
  const needed = new Set(layout.elf.flatMap((row) => row.needed));
  async function selectionTree(base: string, depth = 0): Promise<void> {
    let stat;
    try {
      stat = await lstat(base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (depth > 8 || selectionEntries++ > 4096) return fail();
    await aliases(base);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return fail();
    if (!(await lstat(await realpath(base))).isDirectory()) return fail();
    for (const name of await readdir(base)) {
      if (needed.has(name)) return fail();
      const child = `${base}/${name}`;
      await aliases(child);
      const info = await lstat(child);
      if (info.isDirectory() || info.isSymbolicLink()) await selectionTree(child, depth + 1);
    }
  }
  const requests = [
    ...layout.interpreters.map((row) => row.request),
    ...layout.cache.entries.map((row) => row.path),
  ];
  const defaults =
    process.arch === "x64"
      ? ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib", "/usr/lib"]
      : ["/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib", "/usr/lib"];
  requests.push(...defaults);
  for (const elf of layout.elf) {
    const external = manifest.externalLibraries.find((row) => row.retainedPath === elf.member);
    const origin = path.dirname(external?.path ?? path.join(root, elf.member));
    for (const token of [...elf.rpath, ...elf.runpath]) {
      const value = token.replaceAll("${ORIGIN}", origin).replaceAll("$ORIGIN", origin);
      if (value.includes("$") || !path.isAbsolute(value)) return fail();
      requests.push(value);
    }
  }
  for (const request of requests) {
    await aliases(request);
    const canonical = await realpath(request);
    const stat = await lstat(canonical);
    if (stat.isDirectory()) {
      const kind = canonical.startsWith(`${root}/`) ? "retained" : "system";
      const name = kind === "system" ? canonical : path.relative(root, canonical);
      if (!layout.searchDirectories.some((row) => row.kind === kind && row.path === name))
        return fail();
    }
  }
  for (const directory of layout.searchDirectories.filter((row) => row.kind === "system"))
    for (const name of needed) {
      try {
        const candidate = path.join(directory.path, name);
        await lstat(candidate);
        await aliases(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  for (const directory of layout.searchDirectories) {
    const base = directory.kind === "system" ? directory.path : path.join(root, directory.path);
    await selectionTree(`${base}/glibc-hwcaps`);
    await selectionTree(`${base}/tls`);
  }
  const actual = [...expectedAliases.values()].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  if (!same(actual, layout.aliases)) return fail();
}
/** Byte/identity validation only; never an execution or namespace capability.
 * The caller has already verified the declared retained search directory and
 * its protected route. A generic files row cannot authorize a loader choice. */
export async function assertRetainedSearchElf(
  root: string,
  manifest: ClosureManifest,
  target: string,
): Promise<void> {
  const member = path.relative(root, target);
  safePath(member, false);
  const measured = manifest.systemClosure.loaderResolution.elf.find((row) => row.member === member);
  const file = manifest.files.find((row) => row.path === member);
  if (!measured || !file || path.join(root, member) !== target) return fail();
  const actual = await sourceBytes(target, file);
  const machine = process.arch === "x64" ? 62 : 183;
  if (
    !isTargetElf(actual.bytes, machine) ||
    !same(measured, { member, ...describeElf(actual.bytes) })
  )
    return fail();
  const current = await lstat(target, { bigint: true });
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
    if (actual.stat[key] !== current[key]) return fail();
}
async function assertSearchCandidate(
  root: string,
  manifest: ClosureManifest,
  target: string,
  kind: "system" | "retained",
): Promise<void> {
  if (manifest.externalLibraries.some((item) => item.path === target)) return;
  if (kind !== "retained") return fail();
  await assertRetainedSearchElf(root, manifest, target);
}
async function verifySearchDirectories(root: string, manifest: ClosureManifest): Promise<void> {
  const layout = manifest.systemClosure.loaderResolution;
  const needed = new Set(layout.elf.flatMap((row) => row.needed));
  for (const row of layout.searchDirectories) {
    const directory = row.kind === "system" ? row.path : path.join(root, row.path);
    const stat = await lstat(directory);
    for (let current = directory; ; current = path.dirname(current)) {
      const ancestor = await lstat(current);
      if (ancestor.uid !== 0 || ancestor.mode & 0o022 || ancestor.isSymbolicLink()) return fail();
      if (current === path.dirname(current)) break;
    }
    if (
      !stat.isDirectory() ||
      stat.uid !== 0 ||
      stat.mode & 0o022 ||
      (await realpath(directory)) !== directory
    )
      return fail();
    for (const name of needed) {
      try {
        const target = await realpath(path.join(directory, name));
        await assertSearchCandidate(root, manifest, target, row.kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // lookupInputs already checks the entire protected hwcaps/tls selection tree,
    // including empty writable subdirectories and recursive alias routes.
  }
}
function deviceMatches(value: bigint, major: bigint, minor: bigint): boolean {
  return (
    (((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n)) === major &&
    ((value & 0xffn) | ((value >> 12n) & 0xffffff00n)) === minor
  );
}
/** Current kernel mapping inode is compared to current verified backing inode, never producer inode. */
export async function verifySystemMappings(root: string, manifest: ClosureManifest, pid: number) {
  const before = await readlink(`/proc/${pid}/ns/mnt`);
  const permitted = new Map<string, FileIdentity>(
    manifest.files.map((row) => [path.join(root, row.path), row]),
  );
  for (const row of manifest.externalLibraries) permitted.set(row.path, row);
  const maps = (await readFile(`/proc/${pid}/maps`, "utf8")).split("\n");
  for (const line of maps) {
    const match = line.match(
      /^([a-f0-9]+)-([a-f0-9]+) +[^ ]+ +[^ ]+ +([a-f0-9]+):([a-f0-9]+) +(\d+) +(\/.*)$/,
    );
    if (!match) continue;
    const target = match[6]!;
    if (target.endsWith(" (deleted)") || target.includes("\\")) return fail();
    const canonical = await realpath(target),
      expected = permitted.get(canonical);
    if (!expected) return fail();
    const { stat } = await sourceBytes(canonical, expected);
    if (
      stat.ino !== BigInt(match[5]!) ||
      !deviceMatches(stat.dev, BigInt(`0x${match[3]}`), BigInt(`0x${match[4]}`))
    )
      return fail();
    const external = manifest.externalLibraries.find((row) => row.path === canonical);
    if (external) {
      const { stat: backing } = await sourceBytes(path.join(root, external.retainedPath), {
        ...external,
        path: external.retainedPath,
      });
      if (backing.dev !== stat.dev || backing.ino !== stat.ino) return fail();
    }
  }
  const namespaceIdentity = await readlink(`/proc/${pid}/ns/mnt`);
  if (namespaceIdentity !== before) return fail();
  return { namespaceIdentity, mountinfoSha256: hash(await readFile(`/proc/${pid}/mountinfo`)) };
}
