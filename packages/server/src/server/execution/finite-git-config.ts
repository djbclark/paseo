import { constants, lstatSync } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FiniteGitRecipe } from "./finite-git-profile.js";
import { canonicalBuiltinJson } from "./builtin-format.js";

const stampKeys = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;
const stamp = (info: BigIntStats) => stampKeys.map((key) => String(info[key])).join(":");
const refuse = (): never => {
  throw new Error("Finite Git configuration unsupported");
};
const proofs = new WeakMap<object, Map<string, string | null>>();
export interface FiniteGitConfigProof {
  readonly contract: "protected-git-config-v1";
}

async function protectedBytes(
  file: FiniteGitRecipe["files"][number],
  expectedStamp: string | null | undefined,
): Promise<Buffer> {
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      Number(before.mode & 0o777n) !== file.mode ||
      before.size !== BigInt(file.size)
    )
      return refuse();
    const bytes = Buffer.alloc(file.size + 1);
    let total = 0;
    for (;;) {
      const result = await handle.read(bytes, total, bytes.length - total, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > file.size) return refuse();
    }
    if (
      total !== file.size ||
      stamp(before) !== stamp(await handle.stat({ bigint: true })) ||
      stamp(before) !== expectedStamp
    )
      return refuse();
    const data = bytes.subarray(0, total);
    if (createHash("sha256").update(data).digest("hex") !== file.sha256) return refuse();
    return data;
  } finally {
    await handle.close();
  }
}
/** Checks the retained original configuration, never substitutes config or executes Git. */
export async function observeFiniteGitConfig(
  recipe: FiniteGitRecipe,
): Promise<FiniteGitConfigProof> {
  const observed = new Map<string, string | null>();
  const rootInfo = await lstat("/", { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.uid !== 0n || rootInfo.mode & 0o022n) return refuse();
  observed.set("/", stamp(rootInfo));
  async function route(file: string, mayBeAbsent = false): Promise<string> {
    let current = "/";
    for (const part of file.split("/").filter(Boolean)) {
      if (part === ".") continue;
      if (part === "..") {
        current = path.dirname(current);
        continue;
      }
      current = path.join(current, part);
      let info;
      try {
        info = await lstat(current, { bigint: true });
      } catch (error) {
        if (!mayBeAbsent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        observed.set(current, null);
        return current;
      }
      if (info.uid !== 0n || info.mode & 0o022n || info.isSymbolicLink()) return refuse();
      const old = observed.get(current);
      if (observed.has(current) && old !== stamp(info)) return refuse();
      observed.set(current, stamp(info));
    }
    return current;
  }
  const contents = new Map<string, Buffer>();
  for (const file of recipe.files) {
    await route(file.path);
    contents.set(file.path, await protectedBytes(file, observed.get(file.path)));
  }
  for (const absent of recipe.protectedAbsent) {
    const first = await route(absent, true);
    if (observed.get(first) !== null) return refuse();
  }
  let count = 0;
  async function tree(directory: string, depth = 0): Promise<void> {
    if (depth > 32 || count++ > 4096) return refuse();
    await route(directory);
    const info = await lstat(directory);
    if (!info.isDirectory()) return refuse();
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      await route(file);
      const leaf = await lstat(file);
      if (leaf.isDirectory()) await tree(file, depth + 1);
      else if (!leaf.isFile()) return refuse();
      if (count++ > 4096) return refuse();
    }
  }
  await tree(recipe.repository.cwd);
  const git = recipe.repository.gitDirectory;
  if (!(await lstat(git)).isDirectory()) return refuse();
  for (const name of ["config.worktree", "commondir", "objects/info/alternates", "shallow"])
    if (!recipe.protectedAbsent.includes(`${git}/${name}`)) return refuse();
  for (const name of ["HEAD", "index"])
    if (!contents.has(`${git}/${name}`) && !recipe.protectedAbsent.includes(`${git}/${name}`))
      return refuse();
  const includeEdges: { from: string; to: string }[] = [];
  const values = new Map<string, string>();
  const stack = new Set<string>();
  async function config(file: string): Promise<void> {
    if (stack.has(file) || stack.size >= 8) return refuse();
    stack.add(file);
    const bytes = contents.get(file);
    if (!bytes || !bytes.length) return refuse();
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || text.includes("\0")) return refuse();
    let section = "";
    for (const raw of text.split(/\r?\n/)) {
      const parsed = configLine(raw, section);
      if (parsed.kind === "ignore") continue;
      if (parsed.kind === "section") {
        section = parsed.section;
        continue;
      }
      const { key, value } = parsed;
      if (key === "include.path") {
        if (!value || value.includes("$") || value.startsWith("~")) return refuse();
        const rawTarget = value.startsWith("/") ? value : `${path.dirname(file)}/${value}`;
        const target = await route(rawTarget);
        includeEdges.push({ from: file, to: target });
        if (includeEdges.length > 32) return refuse();
        await config(target);
      } else {
        checkSetting(key, value, recipe);
        values.set(key, value);
      }
    }
    stack.delete(file);
  }
  for (const file of [
    recipe.configRoots.system,
    recipe.configRoots.global,
    recipe.configRoots.local,
  ])
    await config(file);
  if (
    canonicalBuiltinJson(includeEdges) !== canonicalBuiltinJson(recipe.includes) ||
    values.get("core.fsmonitor") !== "false"
  )
    return refuse();
  const hooks = values.get("core.hookspath"),
    excludes = values.get("core.excludesfile");
  if (!hooks || !excludes || !path.isAbsolute(hooks) || !contents.has(excludes)) return refuse();
  await route(hooks);
  if (!(await lstat(hooks)).isDirectory() || (await readdir(hooks)).length) return refuse();
  const proof = Object.freeze({ contract: "protected-git-config-v1" as const });
  proofs.set(proof, observed);
  assertFiniteGitConfigUnchanged(proof);
  return proof;
}
function configLine(
  raw: string,
  section: string,
):
  | { kind: "ignore" }
  | { kind: "section"; section: string }
  | { kind: "assignment"; key: string; value: string } {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith(";")) return { kind: "ignore" };
  const heading = line.match(/^\[([A-Za-z][A-Za-z0-9-]*)\]$/);
  if (heading) return { kind: "section", section: heading[1]!.toLowerCase() };
  const assignment = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*([^"\\#;]*)$/);
  if (!section || !assignment) return refuse();
  return {
    kind: "assignment",
    key: `${section}.${assignment[1]!.toLowerCase()}`,
    value: assignment[2]!.trim(),
  };
}
function checkSetting(key: string, value: string, recipe: FiniteGitRecipe): void {
  const booleans = [
    "core.filemode",
    "core.bare",
    "core.logallrefupdates",
    "core.ignorecase",
    "core.precomposeunicode",
  ];
  if (booleans.includes(key) && ["true", "false"].includes(value)) {
    if (key === "core.bare" && value !== "false") return refuse();
    return;
  }
  if (key === "core.repositoryformatversion" && value === "0") return;
  if (key === "core.fsmonitor" && value === "false") return;
  if (key === "safe.directory" && value === recipe.repository.cwd) return;
  if (["core.excludesfile", "core.hookspath"].includes(key) && path.isAbsolute(value)) return;
  return refuse();
}
/** Private proof identity and immutable routes, not before/after hashes of writable inputs. */
export function assertFiniteGitConfigUnchanged(proof: FiniteGitConfigProof): void {
  const observed = proofs.get(proof);
  if (!observed) return refuse();
  for (const [file, expected] of observed) {
    try {
      const actual = lstatSync(file, { bigint: true });
      if (expected === null || stamp(actual) !== expected) return refuse();
    } catch (error) {
      if (expected !== null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
