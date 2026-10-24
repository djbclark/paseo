import { useMemo } from "react";
import { View } from "react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";
import { useProjectIcons } from "@/projects/icons";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { findWorkspaceProject } from "./model";
import { workspaceAccentKey } from "./store";

const NO_TARGETS: ProjectIconTarget[] = [];
// Initial glyph at 16pt is 9pt, the sidebar's ratio, so the two icons read as the same mark.
const INITIAL_FONT_RATIO = 0.56;

/**
 * The workspace's project icon, the one the sidebar draws: same project lookup, same icon cache
 * entry, so the two always match. Decorative, since the project name is announced next to it.
 * Renders nothing until the project is known.
 */
export function WorkspaceProjectIcon({
  serverId,
  workspaceId,
  size,
}: {
  serverId: string;
  workspaceId: string;
  size: number;
}) {
  const serverIds = useMemo(() => [serverId], [serverId]);
  const { projects } = useWorkspaceStructure(serverIds);
  const project = useMemo(
    () => findWorkspaceProject(projects, workspaceAccentKey(serverId, workspaceId)),
    [projects, serverId, workspaceId],
  );
  const targets = useMemo(() => {
    if (!project) return NO_TARGETS;
    for (const host of project.hosts) {
      const target = createProjectIconTarget({ projectViewKey: project.viewKey, placement: host });
      if (target) return [target];
    }
    return NO_TARGETS;
  }, [project]);
  const iconByViewKey = useProjectIcons({ projects: targets });
  const textStyle = useMemo(() => ({ fontSize: Math.round(size * INITIAL_FONT_RATIO) }), [size]);

  if (!project) return null;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <ProjectIconView
        iconDataUri={iconByViewKey.get(project.viewKey) ?? null}
        initial={projectIconPlaceholderLabelFromDisplayName(project.projectName)
          .charAt(0)
          .toUpperCase()}
        projectViewKey={project.viewKey}
        size={size}
        textStyle={textStyle}
      />
    </View>
  );
}
