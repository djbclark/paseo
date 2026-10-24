import type { ViewStyle } from "react-native";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import {
  IDENTITY_COLOR_NAMES,
  deriveIdentityColorName,
  identityColor,
  identityTint,
  type IdentityColorName,
} from "@/styles/identity-colors";

export type WorkspaceAccent = IdentityColorName;

export interface WorkspaceAccentSources {
  /** A plugin's explicit choice for this workspace. Wins over everything. */
  override: WorkspaceAccent | null;
  /** The view key the sidebar hashes for the project icon; null while the project is unknown. */
  projectViewKey: string | null;
}

/**
 * The color a workspace's chrome carries. Defaults to the project's identity color, derived the
 * same way as the sidebar project icon so the two always agree.
 */
export function resolveWorkspaceAccent(sources: WorkspaceAccentSources): WorkspaceAccent | null {
  if (sources.override) return sources.override;
  if (sources.projectViewKey) return deriveIdentityColorName(sources.projectViewKey);
  return null;
}

/**
 * The key the sidebar hashes for the project icon of the project that holds a workspace.
 * `workspaceKey` is `serverId:workspaceId`, the form `workspaceKeys` uses.
 */
export function findProjectViewKey(
  projects: readonly WorkspaceStructureProject[],
  workspaceKey: string,
): string | null {
  return projects.find((project) => project.workspaceKeys.includes(workspaceKey))?.viewKey ?? null;
}

// `identityTint` and `identityColor` are theme-independent — one hex per name — so these are
// built once at module load, the same way workspace-labels/chip.tsx builds its grounds. No
// Unistyles proxy is involved, so a theme switch cannot freeze them.
export const WORKSPACE_ACCENT_TINT_STYLES = buildStyles((name) => ({
  backgroundColor: identityTint(name),
}));

export const WORKSPACE_ACCENT_FILL_STYLES = buildStyles((name) => ({
  backgroundColor: identityColor(name),
}));

function buildStyles(
  make: (name: WorkspaceAccent) => ViewStyle,
): Record<WorkspaceAccent, ViewStyle> {
  return Object.fromEntries(IDENTITY_COLOR_NAMES.map((name) => [name, make(name)])) as Record<
    WorkspaceAccent,
    ViewStyle
  >;
}
