import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CompactHeader } from "@/components/headers/compact-header";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import { WorkspaceAccentChrome } from "@/workspace-accent/chrome";
import type { WorkspaceAccent } from "@/workspace-accent/model";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  workspaceId: string;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  /** The workspace's identity color, painted behind the header. */
  accent: WorkspaceAccent | null;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  /** Tab switcher and workspace menu, before the explorer toggle. */
  children: ReactNode;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  accent,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  serverId,
  workspaceId,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
        workspaceId={workspaceId}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId, workspaceId],
  );
  const actions = (
    <>
      {children}
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    </>
  );

  const underlay = useMemo(() => <WorkspaceAccentChrome accent={accent} stripe />, [accent]);

  return (
    <CompactHeader
      navigation="menu"
      underlay={underlay}
      title={title}
      titleTestID="workspace-header-title"
      subtitle={projectRow}
      loading={isLoading}
      actions={actions}
    />
  );
}
