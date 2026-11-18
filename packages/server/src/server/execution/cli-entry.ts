import { bindFixedManagedPluginPolicyEnvironment } from "./managed-policy-environment.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
await bindFixedManagedPluginPolicyEnvironment();
await verifyEnclosingProcess(root);
// Transport only: the CLI never mints a daemon owner or accepts a JSON capability.
await import(path.join(root, "cli-code.mjs"));
