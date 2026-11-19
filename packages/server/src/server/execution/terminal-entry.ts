import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
import { recordStartupPhase, startupPhaseNow } from "./startup-phase.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const incarnation = randomUUID();
const queued: string[] = [];
let ready = false;
let diagnosticOrdinal = 0;
process.on("message", (raw: unknown) => {
  if (
    !raw ||
    typeof raw !== "object" ||
    Reflect.get(raw, "type") !== "qualified.execution.challenge"
  )
    return;
  const challenge = Reflect.get(raw, "challenge");
  if (typeof challenge !== "string" || challenge.length > 128) return;
  if (ready) void respond(challenge);
  else if (queued.length < 8) queued.push(challenge);
});
async function respond(challenge: string): Promise<void> {
  const started = startupPhaseNow();
  const span = ++diagnosticOrdinal;
  let outcome: "ok" | "error" = "error";
  let actual: Awaited<ReturnType<typeof verifyEnclosingProcess>>;
  recordStartupPhase({ phase: "terminal.verify", edge: "begin", span });
  try {
    actual = await verifyEnclosingProcess(root);
    outcome = "ok";
  } finally {
    const now = startupPhaseNow();
    recordStartupPhase({
      phase: "terminal.verify",
      edge: "end",
      span,
      outcome,
      durationUs: now !== null && started !== null && now >= started ? now - started : undefined,
    });
  }
  process.send?.({
    challenge,
    incarnation,
    pid: process.pid,
    manifestSha256: actual.manifestSha256,
    distributionBuildId: actual.manifest.distributionBuildId,
  });
}
await verifyEnclosingProcess(root);
await import(path.join(root, "terminal-code.mjs"));
ready = true;
for (const challenge of queued.splice(0)) await respond(challenge);
