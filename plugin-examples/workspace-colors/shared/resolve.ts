import type { ColorSettings, WorkspaceColor } from "./colors";

// Mirrors the protocol's workspaceLabelKey.
export function labelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function resolveWorkspaceColor(
  workspace: { id: string; projectId: string; labels?: readonly string[] },
  settings: ColorSettings,
): WorkspaceColor | null {
  const own = settings.workspaces[workspace.id];
  if (own) return own;
  const keys = new Set((workspace.labels ?? []).map(labelKey));
  const rule = settings.labelRules.find((candidate) => keys.has(labelKey(candidate.label)));
  return rule?.color ?? settings.projects[workspace.projectId] ?? null;
}
