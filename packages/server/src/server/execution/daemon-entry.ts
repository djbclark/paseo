import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
// Builtin-only verifier completes before daemon/bootstrap/SDK imports.
await verifyEnclosingProcess(root);
const runtime = (await import(
  path.join(root, "daemon.mjs")
)) as typeof import("./daemon-runtime.js");
await runtime.startQualifiedDaemon();
