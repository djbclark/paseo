import type { PluginServerContext } from "@getpaseo/plugin/server";
import { colorSettings } from "./shared/colors";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(colorSettings);
  return () => {};
}
