import { spawn } from "node:child_process";
import path from "node:path";
import { verifyQualifiedRoot } from "./launch-verifier.js";

/** Launch specification is evidence/transport, never an in-process capability. */
export function createQualifiedHostInvocation(root: string) {
  const qualified = verifyQualifiedRoot(root);
  return Object.freeze({
    command: path.join(root, qualified.manifest.runtime.path),
    args: Object.freeze([path.join(root, "role.cjs")]),
    env: Object.freeze({ PATH: "/usr/bin:/bin" }),
    manifestSha256: qualified.manifestSha256,
  });
}
/** No caller execArgv/environment/options may run a preload before the producer. */
export function launchQualifiedPluginHost(root: string) {
  const invocation = createQualifiedHostInvocation(root);
  return spawn(invocation.command, [...invocation.args], {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}
