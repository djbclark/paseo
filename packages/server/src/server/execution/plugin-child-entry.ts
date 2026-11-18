import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const challenges: string[] = [];
let respond: ((challenge: string) => Promise<void>) | null = null;
process.on("message", (raw: unknown) => {
  if (
    !raw ||
    typeof raw !== "object" ||
    Reflect.get(raw, "type") !== "qualified.execution.challenge"
  )
    return;
  const challenge = Reflect.get(raw, "challenge");
  if (typeof challenge !== "string" || challenge.length > 128) return;
  if (respond) void respond(challenge);
  else if (challenges.length < 8) challenges.push(challenge);
});
await verifyEnclosingProcess(root);
const runtime = (await import(
  path.join(root, "plugin-worker-code.mjs")
)) as typeof import("./plugin-child-runtime.js");
await runtime.attachQualifiedPluginHost();
respond = runtime.respondQualifiedChallenge;
for (const challenge of challenges.splice(0)) await respond(challenge);
