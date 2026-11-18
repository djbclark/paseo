/* oxlint-disable paseo/no-sync-io -- Isolated Linux qualification boundary: finish observations before publishing the synchronous branded capability. Daemon/main-thread roles remain unsupported; this is not a general server IO exemption. */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
const fail = (): never => {
  throw new Error("Retained-root evidence unsupported");
};
function verifyPath(file: string): void {
  if (file === "/" || !path.isAbsolute(file) || realpathSync(file) !== file) return fail();
  for (let current = file; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) return fail();
    if (current === path.dirname(current)) break;
  }
}
/** First hermetic Linux adapter only. This observation cannot mint a capability. */
export const linuxRetainedRoot = Object.freeze({
  kind: "linux-root-owned-retained-v1" as const,
  verifyPath(file: string): void {
    if (process.platform !== "linux" || process.getuid?.() === 0) return fail();
    verifyPath(file);
  },
});
