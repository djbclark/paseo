import { spawn } from "node:child_process";
import path from "node:path";
import { verifyEnclosingDistribution, unsupported } from "./daemon-verifier.js";
export async function createQualifiedDaemonInvocation(root: string, paseoHome: string) {
  if (!path.isAbsolute(paseoHome)) return unsupported();
  const verified = await verifyEnclosingDistribution(root);
  return Object.freeze({
    command: path.join(root, "runtime/node"),
    args: Object.freeze([path.join(root, "role.cjs")]),
    env: Object.freeze({ PATH: "/usr/bin:/bin", PASEO_HOME: paseoHome }),
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
