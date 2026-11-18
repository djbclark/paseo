import path from "node:path";
import { verifyQualifiedLaunch } from "./launch-verifier.js";
// Builtin-only before the qualified root and executing runtime have been checked.
verifyQualifiedLaunch(__filename);
const host = require(path.join(__dirname, "host.cjs")) as typeof import("./qualified-host.js");
host.getQualifiedHost();
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
