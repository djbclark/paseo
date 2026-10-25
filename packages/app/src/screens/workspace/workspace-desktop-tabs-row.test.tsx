/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { WorkspaceAccent } from "@/workspace-accent/model";
import { WorkspaceDesktopTabsRow } from "./workspace-desktop-tabs-row";

void testI18n;

// A wide tablet: native, not the compact form factor.
vi.mock("@/constants/platform", () => ({ isNative: true, isWeb: false }));
vi.mock("@/constants/layout", () => ({
  WORKSPACE_SECONDARY_HEADER_HEIGHT: 36,
  useIsCompactFormFactor: () => false,
}));

const accentRef = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@/workspace-accent/use-workspace-accent", () => ({
  useWorkspaceAccent: () => accentRef.current,
}));
vi.mock("@/workspace-accent/workspace-project-icon", () => ({
  WorkspaceProjectIcon: () => <i data-testid="project-icon" />,
}));

// The row's other pieces are not what these tests are about.
vi.mock("@/components/sortable-inline-list", () => ({
  SortableInlineList: () => <b data-testid="tabs" />,
}));
vi.mock("@/components/ui/horizontal-scroll-boundary", () => ({
  HorizontalScrollBoundaryShades: () => null,
  useHorizontalScrollBoundary: () => ({
    onLayout: () => {},
    onContentSizeChange: () => {},
    onScroll: () => {},
    leftShadeStyle: {},
    rightShadeStyle: {},
  }),
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  paneContentToolbarTrailingPadding: () => 0,
  ToolbarButton: () => null,
  ToolbarControls: () => null,
}));
vi.mock("@/components/ui/icon-button-chrome", () => ({ smallIconButtonChromeFrameSize: () => 24 }));
vi.mock("@/components/ui/control-geometry", () => ({ buttonControlHeight: () => 28 }));
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: () => null,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuTrigger: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: () => null,
  TooltipContent: () => null,
  TooltipTrigger: () => null,
}));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("@/components/ui/trailing-action-scrim", () => ({ TrailingActionScrim: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => null }));
vi.mock("@/hooks/use-keyboard-action-handler", () => ({ useKeyboardActionHandler: () => {} }));
vi.mock("@/hooks/use-time-ago", () => ({ useCompactTimeAgo: () => "" }));
vi.mock("@/file-panels", () => ({ useFilePanelOpenWithMenu: () => ({ pages: [] }) }));
vi.mock("@/workspace-accent/tab-color-menu", () => ({
  useTabColorMenu: () => ({ trigger: null, pages: [] }),
}));
vi.mock("@/workspace-accent/use-tab-accents", () => ({ setTabAccent: () => {} }));
vi.mock("@/screens/workspace/workspace-new-tab-menu", () => ({
  WorkspaceNewTabMenuContent: () => null,
}));
vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: () => null,
  WorkspaceTabIcon: () => null,
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => null }));
vi.mock("react-native-reanimated", async () => {
  const { ScrollView } = await import("react-native");
  return {
    default: { ScrollView },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
  };
});

const NOOP = () => {};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderRow(input: { accent: WorkspaceAccent | null; focusMode?: boolean }): HTMLElement {
  accentRef.current = input.accent;
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() =>
    root?.render(
      <WorkspaceDesktopTabsRow
        tabs={[]}
        normalizedServerId="host"
        normalizedWorkspaceId="w1"
        setHoveredCloseTabKey={NOOP}
        onNavigateTab={NOOP}
        onCloseTab={NOOP}
        onCopyResumeCommand={NOOP}
        onCopyAgentId={NOOP}
        onCopyTerminalId={NOOP}
        onCopyFilePath={NOOP}
        onReloadAgent={NOOP}
        onRenameTab={NOOP}
        onCloseTabsToLeft={NOOP}
        onCloseTabsToRight={NOOP}
        onCloseOtherTabs={NOOP}
        onCreateNewTab={NOOP}
        onReorderTabs={NOOP}
        focusModeEnabled={input.focusMode ?? false}
        onExitFocusMode={NOOP}
      />,
    ),
  );
  const row = container.querySelector<HTMLElement>('[data-testid="workspace-tabs-row"]');
  if (!row) throw new Error("tabs row did not render");
  return row;
}

describe("WorkspaceDesktopTabsRow on a wide native layout", () => {
  it("carries the project icon when no pane split chooses the icon's row", () => {
    const row = renderRow({ accent: "teal" });
    expect(row.querySelector('[data-testid="project-icon"]')).not.toBeNull();
  });

  it("drops the project icon in focus mode", () => {
    const row = renderRow({ accent: "teal", focusMode: true });
    expect(row.querySelector('[data-testid="project-icon"]')).toBeNull();
  });
});
