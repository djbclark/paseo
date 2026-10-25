import { settingsRpc } from "@getpaseo/plugin";
import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginIdentityColor,
  PluginWorkspaceAccentRegistration,
} from "@getpaseo/plugin/client";
import { COLORS, colorSettings, type ColorSettings } from "../shared/colors";
import { resolveWorkspaceColor } from "../shared/resolve";
import { swatchFor } from "./swatches";

interface Workspace {
  id: string;
  projectId: string;
  labels?: readonly string[];
}

const rpc = settingsRpc(colorSettings.id);
const EMPTY: ColorSettings = { workspaces: {}, projects: {}, labelRules: [] };
const WRITE_ATTEMPTS = 2;

function parseSettings(values: unknown): ColorSettings {
  const parsed = colorSettings.schema.safeParse(values);
  return parsed.success ? parsed.data : EMPTY;
}

const titleCase = (color: string) => color.charAt(0).toUpperCase() + color.slice(1);

export function startWorkspaceColors(client: PluginClientContext): () => void {
  const workspaces = new Map<string, Workspace>();
  const accents = new Map<
    string,
    { color: PluginIdentityColor; registration: PluginWorkspaceAccentRegistration }
  >();
  // The registration and the inputs its menu was built from. Updating a button with a new menu
  // closes it if open, so it is rebuilt only when those inputs change.
  const buttons = new Map<string, { registration: PluginButtonRegistration; inputs: string }>();
  const releases: (() => void)[] = [];
  let settings = EMPTY;
  let reads = 0;
  let stopped = false;

  // Reads, changes and writes with the revision; one retry covers a write from another client.
  async function change(edit: (current: ColorSettings) => ColorSettings) {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const read = await client.rpc(rpc.read, {});
      if (read.status !== "ready")
        throw new Error("The color settings are invalid. Reset them in plugin settings.");
      const result = await client.rpc(rpc.write, {
        revision: read.revision,
        values: edit(parseSettings(read.values)),
      });
      if (result.status === "saved") {
        reads += 1;
        settings = parseSettings(result.values);
        sync();
        return;
      }
      if (result.status === "invalid") throw new Error(result.error);
    }
    throw new Error("The color settings changed elsewhere. Try again.");
  }

  const setColor = (
    scope: "workspaces" | "projects",
    id: string,
    color: PluginIdentityColor | null,
  ) =>
    change((current) => {
      const { [id]: _previous, ...rest } = current[scope];
      return { ...current, [scope]: color ? { ...rest, [id]: color } : rest };
    });
  const setWorkspaceColor = (id: string, color: PluginIdentityColor | null) =>
    setColor("workspaces", id, color);
  const setProjectColor = (id: string, color: PluginIdentityColor | null) =>
    setColor("projects", id, color);

  function swatchItems(
    prefix: string,
    selected: PluginIdentityColor | undefined,
    choose: (color: PluginIdentityColor) => Promise<void>,
  ): PluginButtonMenuEntry[] {
    return COLORS.map((color) => ({
      kind: "item",
      id: `${prefix}-${color}`,
      title: titleCase(color),
      icon: swatchFor(color, color === selected),
      behavior: { kind: "action", onPress: () => choose(color) },
    }));
  }

  function buildButton(workspace: Workspace): PluginButton {
    const own = settings.workspaces[workspace.id];
    return {
      title: "Workspace color",
      icon: "Palette",
      behavior: {
        kind: "menu",
        items: [
          ...swatchItems("workspace", own, (color) => setWorkspaceColor(workspace.id, color)),
          {
            kind: "item",
            id: "use-project",
            title: "Use project color",
            icon: "Undo2",
            visible: own !== undefined,
            behavior: { kind: "action", onPress: () => setWorkspaceColor(workspace.id, null) },
          },
          { kind: "separator", id: "project-divider" },
          {
            kind: "item",
            id: "project-color",
            title: "Project color",
            icon: "Folder",
            behavior: {
              kind: "menu",
              items: [
                ...swatchItems("project", settings.projects[workspace.projectId], (color) =>
                  setProjectColor(workspace.projectId, color),
                ),
                {
                  kind: "item",
                  id: "project-clear",
                  title: "Clear",
                  icon: "X",
                  behavior: {
                    kind: "action",
                    onPress: () => setProjectColor(workspace.projectId, null),
                  },
                },
              ],
            },
          },
          {
            kind: "item",
            id: "open-settings",
            title: "Color settings…",
            icon: "Settings",
            behavior: { kind: "action", onPress: () => client.openSettings(colorSettings.id) },
          },
        ],
      },
    };
  }

  function sync() {
    if (stopped) return;
    for (const workspace of workspaces.values()) {
      const color = resolveWorkspaceColor(workspace, settings);
      const current = accents.get(workspace.id);
      if (!color) {
        current?.registration.remove();
        accents.delete(workspace.id);
      } else if (!current) {
        const registration = client.setWorkspaceAccent({ workspaceId: workspace.id, color });
        accents.set(workspace.id, { color, registration });
      } else if (current.color !== color) {
        current.registration.update({ color });
        current.color = color;
      }
      const inputs = [
        workspace.id,
        workspace.projectId,
        settings.workspaces[workspace.id] ?? "",
        settings.projects[workspace.projectId] ?? "",
      ].join("\0");
      const existing = buttons.get(workspace.id);
      if (!existing) {
        buttons.set(workspace.id, {
          inputs,
          registration: client.addHeaderButton({
            id: "workspace-color",
            workspaceId: workspace.id,
            button: buildButton(workspace),
          }),
        });
      } else if (existing.inputs !== inputs) {
        existing.registration.update(buildButton(workspace));
        existing.inputs = inputs;
      }
    }
    for (const [id, accent] of accents) {
      if (workspaces.has(id)) continue;
      accent.registration.remove();
      accents.delete(id);
    }
    for (const [id, button] of buttons) {
      if (workspaces.has(id)) continue;
      button.registration.remove();
      buttons.delete(id);
    }
  }

  async function reload() {
    reads += 1;
    const ticket = reads;
    try {
      const read = await client.rpc(rpc.read, {});
      if (stopped || ticket !== reads) return;
      settings = read.status === "ready" ? parseSettings(read.values) : EMPTY;
    } catch (error) {
      if (!stopped) console.error("Workspace colors could not read its settings", error);
      return;
    }
    sync();
  }

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) return subscription.release();
      releases.push(() => void subscription.release());
      subscription.subscribe({
        snapshot: ({ entries }) => {
          workspaces.clear();
          for (const entry of entries) workspaces.set(entry.id, entry);
          sync();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "remove") workspaces.delete(update.id);
          else workspaces.set(update.workspace.id, update.workspace);
          sync();
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Workspace observation failed", error);
    });

  const events = client.paseo.observeEvents(["status.plugin_settings_changed"]);
  events.subscribe({
    snapshot: () => void reload(),
    update: (message) => {
      if (message.type !== "status" || message.payload.status !== "plugin_settings_changed") return;
      if (message.payload.settingsId === colorSettings.id) void reload();
    },
  });
  releases.push(() => void events.release().catch(() => {}));

  return () => {
    stopped = true;
    for (const release of releases) release();
    for (const accent of accents.values()) accent.registration.remove();
    for (const button of buttons.values()) button.registration.remove();
    accents.clear();
    buttons.clear();
    workspaces.clear();
  };
}
