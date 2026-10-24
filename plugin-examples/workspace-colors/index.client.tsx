// COMPAT(pluginWorkspaceAccent): added in v0.14.0, remove after 2027-04-24
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startWorkspaceColors } from "./client/controller";
import { ColorSettingsScreen } from "./client/settings-screen";
import { colorSettings } from "./shared/colors";

export default function contribute(client: PluginClientContext) {
  if (typeof client.setWorkspaceAccent !== "function") return () => {};
  const removeScreen = client.addSettingsScreen({
    id: colorSettings.id,
    title: "Workspace colors",
    icon: "Palette",
    Component: ColorSettingsScreen,
  });
  const stop = startWorkspaceColors(client);
  return () => {
    stop();
    removeScreen();
  };
}
