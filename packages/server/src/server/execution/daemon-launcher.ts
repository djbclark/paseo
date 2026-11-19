import { qualifiedDaemonStartupEnvironment } from "./finite-git-environment.js";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  verifyEnclosingDistribution,
  assertEnclosingAuthorityUnchanged,
  unsupported,
} from "./daemon-verifier.js";
export async function createQualifiedDaemonInvocation(root: string, paseoHome: string) {
  if (!path.isAbsolute(paseoHome)) return unsupported();
  const verified = await verifyEnclosingDistribution(root);
  const environment = await qualifiedDaemonStartupEnvironment(root, paseoHome, verified);
  await assertEnclosingAuthorityUnchanged(verified);
  return Object.freeze({
    command: path.join(root, "runtime/node"),
    args: Object.freeze([path.join(root, "role.cjs")]),
    env: Object.freeze(environment),
    closure: verified.closure,
  });
}
export async function launchQualifiedDaemon(root: string, paseoHome: string) {
  const invocation = await createQualifiedDaemonInvocation(root, paseoHome);
  return spawn(invocation.command, [...invocation.args], {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}
