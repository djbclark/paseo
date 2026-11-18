import { workerData, MessagePort, threadId } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installCompilerHelperOwner } from "./compiler-helpers.js";
import { assertEnclosingAuthorityUnchanged, verifyEnclosingProcess } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const transferred: unknown = workerData?.qualificationPort;
if (!(transferred instanceof MessagePort))
  throw new Error("Missing owned compiler observation channel");
const port = transferred;
const initial = await verifyEnclosingProcess(root);
if (process.env.ESBUILD_BINARY_PATH !== path.join(root, "runtime/esbuild"))
  throw new Error("Unqualified compiler helper");
// Ordinary compiler jobs stay on parentPort; this private channel cannot be a job.
const helperOwner = await installCompilerHelperOwner(root, () => {
  port.postMessage({ type: "qualified.execution.unknown" });
});
const incarnation = randomUUID();
const queued: string[] = [];
let initialized = false;
let stopping = false;
let compilerRuntime: object | null = null;
port.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  if (Reflect.get(raw, "type") === "qualified.execution.stop") {
    const challenge = Reflect.get(raw, "challenge");
    if (stopping || typeof challenge !== "string" || challenge.length > 128) return;
    stopping = true;
    const retire = compilerRuntime
      ? Reflect.get(compilerRuntime, "retireQualifiedCompilerTasks")
      : undefined;
    if (!initialized || typeof retire !== "function") {
      port.postMessage({ type: "qualified.execution.unknown" });
      return;
    }
    // Fixed real worker export closes task ingress synchronously on this call.
    // Existing tasks keep their helper ownership until their actual completion.
    let admitted: Promise<void>;
    try {
      admitted = retire();
      helperOwner.sealAdmission();
    } catch {
      port.postMessage({ type: "qualified.execution.unknown" });
      return;
    }
    void admitted
      .then(() => helperOwner.stop())
      .then(() => {
        port.postMessage({
          type: "qualified.execution.stopped",
          challenge,
          incarnation,
          pid: process.pid,
          threadId,
          manifestSha256: initial.manifestSha256,
          distributionBuildId: initial.manifest.distributionBuildId,
        });
        return process.exit(0);
      })
      .catch(() => {
        port.postMessage({ type: "qualified.execution.unknown" });
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
  const current = await verifyEnclosingProcess(root);
  await helperOwner.settled();
  await assertEnclosingAuthorityUnchanged(current);
  port.postMessage({
    challenge,
    incarnation,
    pid: process.pid,
    threadId,
    manifestSha256: initial.manifestSha256,
    distributionBuildId: initial.manifest.distributionBuildId,
  });
}
await assertEnclosingAuthorityUnchanged(initial);
compilerRuntime = await import(path.join(root, "compiler-code.mjs"));
initialized = true;
for (const challenge of queued.splice(0)) await respond(challenge);
