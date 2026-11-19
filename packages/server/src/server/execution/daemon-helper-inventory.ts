import { createHash } from "node:crypto";
import type { FileIdentity } from "./types.js";
import type { RetainedExternal } from "./system-closure.js";

const bridgeHelpers = new Set([
  "bridge-assets/identity.json",
  "bridge-assets/v1.metafile.json",
  "bridge-assets/v2.metafile.json",
  "bridge-plugin.bundle.mjs",
  "v2/bridge-plugin.bundle.mjs",
  "v2/state.mjs",
]);
interface HelperFiles {
  readonly files: readonly FileIdentity[];
  readonly externalLibraries: readonly RetainedExternal[];
}
interface HelperManifest extends HelperFiles {
  readonly helperInventory: readonly FileIdentity[];
  readonly helperClosureSha256: string;
}
/** One finite selector for build and runtime; rows retain their complete identity. */
export function daemonHelperInventory(manifest: HelperFiles): FileIdentity[] {
  return [
    ...manifest.files.filter(
      (file) =>
        file.path.startsWith("system-closure/") ||
        file.path.startsWith("native-provenance/") ||
        bridgeHelpers.has(file.path) ||
        file.path.startsWith("runtime/") ||
        /(?:compiler|terminal)-(?:entry|code)\.mjs$/.test(file.path) ||
        file.path.endsWith(".node") ||
        /\.so(?:\.[0-9]+)*$/.test(file.path) ||
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
}
/** Same strict runtime data guard. Never grants execution/owner/namespace authority. */
export function assertDaemonHelperInventory(manifest: HelperManifest): string {
  const inventory = daemonHelperInventory(manifest);
  const encoded = JSON.stringify(inventory);
  const digest = createHash("sha256").update(encoded).digest("hex");
  if (
    manifest.helperClosureSha256 !== digest ||
    JSON.stringify(manifest.helperInventory) !== encoded
  )
    throw new Error("Enclosing daemon execution unsupported");
  return digest;
}
