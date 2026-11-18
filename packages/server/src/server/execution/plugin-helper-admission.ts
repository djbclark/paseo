import { qualifiedBindings } from "./qualified-bindings.js";
/** Fixed zero-helper profile, installed before candidate evaluation in each realm. */
export function installQualifiedPluginHelperGuard(): void {
  const activity = qualifiedBindings["@getpaseo/plugin/internal/activity"];
  const install = activity ? Reflect.get(activity, "installQualifiedHelperAdmission") : undefined;
  if (typeof install !== "function") throw new Error("Qualified SDK helper admission unavailable");
  install(() => {
    throw new Error("Qualified plugin external helper unsupported");
  });
}
