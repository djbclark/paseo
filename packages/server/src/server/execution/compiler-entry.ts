import { workerData, MessagePort, threadId } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installCompilerHelperOwner } from "./compiler-helpers.js";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const port: unknown = workerData?.qualificationPort;
if (!(port instanceof MessagePort)) throw new Error("Missing owned compiler observation channel");
const initial = await verifyEnclosingProcess(root);
if (process.env.ESBUILD_BINARY_PATH !== path.join(root, "runtime/esbuild"))
  throw new Error("Unqualified compiler helper");
// Ordinary compiler jobs stay on parentPort; this private channel cannot be a job.
const helperOwner = await installCompilerHelperOwner(root, () => {
  (port as MessagePort).postMessage({ type: "qualified.execution.unknown" });
});
const incarnation = randomUUID();
const queued: string[] = [];
let initialized = false;
port.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  if (Reflect.get(raw, "type") === "qualified.execution.stop") {
    void helperOwner
      .stop()
      .then(() => {
        (port as MessagePort).postMessage({ type: "qualified.execution.stopped" });
        process.exit(0);
      })
      .catch(() => {
        (port as MessagePort).postMessage({ type: "qualified.execution.unknown" });
      });
    return;
  }
  if (Reflect.get(raw, "type") !== "qualified.execution.challenge") return;
  const challenge = Reflect.get(raw, "challenge");
  if (typeof challenge !== "string" || challenge.length > 128) return;
  if (initialized) void respond(challenge);
  else if (queued.length < 8) queued.push(challenge);
});
async function respond(challenge: string): Promise<void> {
  await helperOwner.settled();
  (port as MessagePort).postMessage({
    challenge,
    incarnation,
    pid: process.pid,
    threadId,
    manifestSha256: initial.manifestSha256,
    distributionBuildId: initial.manifest.distributionBuildId,
  });
}
await import(path.join(root, "compiler-code.mjs"));
initialized = true;
for (const challenge of queued.splice(0)) await respond(challenge);
