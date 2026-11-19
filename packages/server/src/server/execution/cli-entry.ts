import { bindFixedManagedPluginPolicyEnvironment } from "./managed-policy-environment.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
import { recordStartupPhase, startupPhaseNow } from "./startup-phase.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const started = startupPhaseNow();
let outcome: "ok" | "error" = "error";
recordStartupPhase({ phase: "cli.total", edge: "begin" });
try {
  await bindFixedManagedPluginPolicyEnvironment();
  await verifyEnclosingProcess(root);
  outcome = "ok";
} finally {
  const now = startupPhaseNow();
  recordStartupPhase({
    phase: "cli.total",
    edge: "end",
    outcome,
    durationUs: now !== null && started !== null && now >= started ? now - started : undefined,
  });
}
// Transport only: the CLI never mints a daemon owner or accepts a JSON capability.
await import(path.join(root, "cli-code.mjs"));
