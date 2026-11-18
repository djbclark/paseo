import path from "node:path";
import { verifyQualifiedLaunch } from "./launch-verifier.js";
// Builtin-only before the qualified root and executing runtime have been checked.
verifyQualifiedLaunch(__filename);
const host = require(path.join(__dirname, "host.cjs")) as typeof import("./qualified-host.js");
host.getQualifiedHost();
function helperAdmissionProbe(): boolean {
  const server = host.getQualifiedHost().bindings["@getpaseo/plugin/server"];
  const spawnHelper = server ? Reflect.get(server, "spawnProcess") : undefined;
  if (typeof spawnHelper !== "function") return false;
  try {
    const child = spawnHelper(process.execPath, [
      "-e",
      "process.exit(0)",
    ]) as import("node:child_process").ChildProcess;
    child.kill();
    return false;
  } catch (error) {
    return (
      error instanceof Error && error.message === "Qualified plugin external helper unsupported"
    );
  }
}
process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object" || !("challenge" in raw) || typeof raw.challenge !== "string")
    return;
  const observation = host.inspectQualifiedHost();
  const probe = observation.supported
    ? host.evaluateQualifiedBundle('(require) => require("@getpaseo/plugin")') ===
      host.getQualifiedHost().bindings["@getpaseo/plugin"]
    : false;
  const local = observation.supported ? host.getQualifiedHost().binding : null;
  process.send?.({
    challenge: raw.challenge,
    ...observation,
    bindingProbe: probe,
    rejectedSdkHelperOutsideOwner: observation.supported ? helperAdmissionProbe() : true,
    rejectedPrivateImports: [
      "@getpaseo/plugin/internal/activity",
      "@getpaseo/client/internal/daemon-client",
      "@getpaseo/protocol/binary-frames/index",
      "node:child_process",
      "./execution/qualified-host.js",
    ].every((name) => {
      if (!observation.supported) return true;
      try {
        host.qualifiedRuntimeRequire(name);
        return false;
      } catch {
        return true;
      }
    }),
    rejectedRelabel: local
      ? !host.isQualifiedExecutionBinding(local, "daemon") &&
        !host.isQualifiedExecutionBinding(local, "supervisor") &&
        !host.isQualifiedExecutionBinding(local, "compiler")
      : true,
    rejectedJsonCapability: !host.isQualifiedExecutionBinding(
      local ? JSON.parse(JSON.stringify(local)) : {},
      "plugin-host",
    ),
  });
});
if (!process.send) {
  process.stdout.write(JSON.stringify(host.inspectQualifiedHost()) + "\n");
}
