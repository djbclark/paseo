import { assertQualifiedDaemonStartupEnvironment } from "./finite-git-environment.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyEnclosingProcess, assertEnclosingAuthorityUnchanged } from "./daemon-verifier.js";
const root = path.dirname(fileURLToPath(import.meta.url));
// Builtin-only verifier completes before daemon/bootstrap/SDK imports.
const verified = await verifyEnclosingProcess(root);
await assertQualifiedDaemonStartupEnvironment(root, verified);
await assertEnclosingAuthorityUnchanged(verified);
const runtime = (await import(
  path.join(root, "daemon.mjs")
)) as typeof import("./daemon-runtime.js");
await runtime.startQualifiedDaemon();
