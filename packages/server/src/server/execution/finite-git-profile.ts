import { z } from "zod";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalBuiltinJson } from "./builtin-format.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z
  .string()
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value,
  );
const Absolute = Text.refine(
  (value) => value.startsWith("/") && value === path.posix.normalize(value),
);
export const finiteGitArgv = Object.freeze({
  lsFiles: Object.freeze([
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-from=.worktreeinclude",
    "-z",
  ] as const),
  checkIgnore: Object.freeze(["check-ignore", "--stdin", "-z"] as const),
});
const Recipe = z
  .object({
    contract: z.literal("worktree-include-git-config-v1"),
    distributionManifestSha256: Digest,
    systemClosureSha256: Digest,
    tools: z
      .object({
        git: z.literal("runtime/git"),
        observer: z.literal("runtime/git-observer"),
        gate: z.literal("runtime/git-gate.so"),
      })
      .strict(),
    argv: z
      .object({
        lsFiles: z.tuple([
          z.literal("ls-files"),
          z.literal("--others"),
          z.literal("--ignored"),
          z.literal("--exclude-from=.worktreeinclude"),
          z.literal("-z"),
        ]),
        checkIgnore: z.tuple([z.literal("check-ignore"), z.literal("--stdin"), z.literal("-z")]),
      })
      .strict(),
    repository: z
      .object({ cwd: Absolute, gitDirectory: Absolute, layout: z.literal("direct-dotgit-v1") })
      .strict(),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), Text),
    configRoots: z.object({ system: Absolute, global: Absolute, local: Absolute }).strict(),
    includes: z.array(z.object({ from: Absolute, to: Absolute }).strict()).max(32),
    files: z
      .array(
        z
          .object({
            path: Absolute,
            mode: z.literal(292),
            size: z.number().int().nonnegative().max(1048576),
            sha256: Digest,
          })
          .strict(),
      )
      .max(64),
    protectedAbsent: z.array(Absolute).max(64),
  })
  .strict();
const Profile = z
  .object({ schemaVersion: z.literal(1), recipeSha256: Digest, recipe: Recipe })
  .strict();
export type FiniteGitProfile = z.infer<typeof Profile>;
export type FiniteGitRecipe = FiniteGitProfile["recipe"];
const orderedUnique = (values: string[]) =>
  values.every(
    (value, index) =>
      index === 0 || Buffer.compare(Buffer.from(values[index - 1]!), Buffer.from(value)) < 0,
  );
function completeShape(recipe: FiniteGitRecipe): boolean {
  const files = new Set(recipe.files.map((row) => row.path));
  return (
    recipe.repository.gitDirectory === `${recipe.repository.cwd}/.git` &&
    recipe.configRoots.local === `${recipe.repository.gitDirectory}/config` &&
    recipe.configRoots.system === recipe.environment.GIT_CONFIG_SYSTEM &&
    recipe.configRoots.global === recipe.environment.GIT_CONFIG_GLOBAL &&
    Object.values(recipe.configRoots).every((file) => files.has(file)) &&
    recipe.includes.every((edge) => files.has(edge.from) && files.has(edge.to)) &&
    orderedUnique(recipe.files.map((row) => row.path)) &&
    orderedUnique(recipe.protectedAbsent) &&
    recipe.protectedAbsent.every((file) => !files.has(file)) &&
    recipe.files.reduce((total, row) => total + row.size, 0) <= 8 * 1048576 &&
    Object.keys(recipe.environment).length <= 32 &&
    Buffer.byteLength(canonicalBuiltinJson(recipe.environment)) <= 32768
  );
}
/** Data-only parsing. No authority, live-root check, config read-set or helper grant. */
export function readFiniteGitProfile(value: unknown): FiniteGitProfile | null {
  const result = Profile.safeParse(value);
  if (!result.success) return null;
  const profile = result.data;
  const canonical = canonicalBuiltinJson(profile.recipe);
  if (
    Buffer.byteLength(canonical) > 65536 ||
    !completeShape(profile.recipe) ||
    createHash("sha256").update(canonical).digest("hex") !== profile.recipeSha256
  )
    return null;
  return profile;
}
