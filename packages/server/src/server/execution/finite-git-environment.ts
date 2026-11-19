import { userInfo } from "node:os";
import path from "node:path";
import type { QualifiedBuiltinProfile } from "./builtin-profile.js";
import type { DaemonManifest } from "./daemon-types.js";
import { qualifiedManagedEnvironment } from "./managed-policy-environment.js";
import { observeFiniteGitConfig } from "./finite-git-config.js";
import { observeOriginalGitSelection, closeOriginalGitSelection } from "./finite-git-selection.js";
import { canonicalBuiltinJson } from "./builtin-format.js";

interface StartupSource {
  manifest: DaemonManifest;
  manifestSha256: string;
  authorityIdentity: string;
  builtinProfiles: QualifiedBuiltinProfile[] | null;
}
/** Closed projection of existing protected DATA; no ambient environment forwarding. */
export function declaredFiniteGitEnvironment(
  profile: NonNullable<QualifiedBuiltinProfile["finiteGit"]>,
  base: Record<string, string>,
  paseoHome: string,
): Record<string, string> {
  const recipe = profile.recipe;
  const declared = recipe.environment;
  const expected: Record<string, string> = {
    ...base,
    PASEO_HOME: paseoHome,
    GIT_CONFIG_SYSTEM: recipe.configRoots.system,
    GIT_CONFIG_GLOBAL: recipe.configRoots.global,
  };
  for (const key of ["LANG", "LC_ALL"] as const) {
    if (!Object.hasOwn(declared, key)) continue;
    if (declared[key] !== "C") throw new Error("Finite Git startup locale unsupported");
    expected[key] = "C";
  }
  if (
    base.PATH !== "/usr/bin:/bin" ||
    base.HOME !== userInfo().homedir ||
    !path.isAbsolute(paseoHome) ||
    canonicalBuiltinJson(expected) !== canonicalBuiltinJson(declared)
  )
    throw new Error("Finite Git original startup environment mismatch");
  return expected;
}
export async function qualifiedDaemonStartupEnvironment(
  root: string,
  paseoHome: string,
  source: StartupSource,
): Promise<Record<string, string>> {
  if (!path.isAbsolute(root)) throw new Error("Finite Git startup root invalid");
  const base = await qualifiedManagedEnvironment();
  const finite = source.builtinProfiles?.find((row) => row.id === "worktree-include")?.finiteGit;
  if (!finite) return { ...base, PASEO_HOME: paseoHome };
  if (
    finite.recipe.distributionManifestSha256 !== source.manifestSha256 ||
    finite.recipe.systemClosureSha256 !== source.manifest.systemClosureSha256
  )
    throw new Error("Finite Git startup closure mismatch");
  const environment = declaredFiniteGitEnvironment(finite, base, paseoHome);
  await observeFiniteGitConfig(finite.recipe);
  const expected = source.manifest.files.find((row) => row.path === "runtime/git");
  if (!expected) throw new Error("Retained Git startup identity missing");
  const selection = await observeOriginalGitSelection(expected);
  await closeOriginalGitSelection(selection);
  return environment;
}

/** Called by the fixed entry BEFORE daemon imports and by actual owner refresh. */
export async function assertQualifiedDaemonStartupEnvironment(
  root: string,
  source: StartupSource,
): Promise<void> {
  const finite = source.builtinProfiles?.find((row) => row.id === "worktree-include")?.finiteGit;
  if (!finite) return;
  const expected = await qualifiedDaemonStartupEnvironment(
    root,
    process.env.PASEO_HOME ?? "",
    source,
  );
  const actual = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  if (canonicalBuiltinJson(actual) !== canonicalBuiltinJson(expected))
    throw new Error("Original daemon Git startup environment changed");
}
