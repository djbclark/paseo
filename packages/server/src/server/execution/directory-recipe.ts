import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalBuiltinJson } from "./builtin-format.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Compiler = z
  .object({
    version: z.literal(1),
    contract: z.literal("ade-directory-entry-v1"),
    role: z.enum(["claim", "window"]),
    entry: z.literal("index.directory.server.ts"),
    target: z.literal("server"),
    client: z.literal("none"),
  })
  .strict();
export const DirectoryHelperRecipeSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("ade-directory-helpers-v1"),
    initialization: z.literal("registration-only"),
    qualificationSha256: Digest,
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    moduleTableSha256: Digest,
    compiler: Compiler,
  })
  .strict();
const Profile = z
  .object({
    version: z.literal(1),
    contract: z.literal("ade-directory-helpers-v1"),
    initialization: z.literal("registration-only"),
    qualificationSha256: Digest,
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    moduleTableSha256: Digest,
    recipeSha256: Digest,
  })
  .strict();

export type DirectoryHelperRecipe = Readonly<
  Omit<z.infer<typeof DirectoryHelperRecipeSchema>, "compiler"> & {
    compiler: Readonly<z.infer<typeof Compiler>>;
  }
>;

/** Identity DATA only. A match cannot authorize a task, realm, helper or evaluator. */
export function parseDirectoryHelperRecipe(
  value: unknown,
  profileValue: unknown,
  pluginId: string,
): DirectoryHelperRecipe | null {
  const parsed = DirectoryHelperRecipeSchema.safeParse(value);
  const enrolled = Profile.safeParse(profileValue);
  if (!parsed.success || !enrolled.success) return null;
  const recipe = parsed.data;
  const profile = enrolled.data;
  const expectedId = recipe.compiler.role === "claim" ? "ade-claim" : "ade-window-name";
  if (pluginId !== expectedId) return null;
  for (const key of [
    "qualificationSha256",
    "runtimeClosureSha256",
    "helperClosureSha256",
    "moduleTableSha256",
  ] as const)
    if (recipe[key] !== profile[key]) return null;
  const canonical = canonicalBuiltinJson(recipe);
  if (
    Buffer.byteLength(canonical, "utf8") > 65536 ||
    createHash("sha256").update(canonical).digest("hex") !== profile.recipeSha256
  )
    return null;
  Object.freeze(recipe.compiler);
  return Object.freeze(recipe);
}
