import { admitBuiltinHelper } from "./builtin-instance.js";
import type { PluginHelperAdmissionRequest } from "@getpaseo/plugin/internal/activity";
import { qualifiedBindings } from "./qualified-bindings.js";
declare const __QUALIFIED_DAEMON_ENTRY__: boolean;
/** Same installed SDK singleton; only original live builtin roots admit ordinary helper work. */
export function installQualifiedPluginHelperGuard(): void {
  const activity = qualifiedBindings["@getpaseo/plugin/internal/activity"];
  const install = activity ? Reflect.get(activity, "installQualifiedHelperAdmission") : undefined;
  if (typeof install !== "function") throw new Error("Qualified SDK helper admission unavailable");
  install((request: PluginHelperAdmissionRequest) => {
    if (typeof __QUALIFIED_DAEMON_ENTRY__ !== "undefined" && __QUALIFIED_DAEMON_ENTRY__)
      return admitBuiltinHelper(request);
    throw new Error("Qualified plugin external helper unsupported");
  });
}
