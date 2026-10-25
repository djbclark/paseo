/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingHeaderLayout } from "@/components/floating-header";
import { CompactWorkspaceHeader } from "./index";

const { mockTheme } = vi.hoisted(() => ({
  mockTheme: {
    spacing: { 2: 8, 3: 12 },
    colors: {},
    borderRadius: { full: 999 },
    fontSize: { base: 14, lg: 16 },
    fontWeight: { medium: "500" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (theme: unknown) => unknown)(mockTheme) : factory,
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
vi.mock("expo-router", () => ({ router: { back: () => {} } }));
vi.mock("lucide-react-native", () => ({ ArrowLeft: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/headers/header-toggle-button", () => ({ HeaderToggleButton: () => null }));
vi.mock("@/components/headers/sidebar-menu-toggle", () => ({ SidebarMenuToggle: () => null }));
vi.mock("@/components/ui/icon-button-chrome", () => ({
  IconButtonChromeProvider: ({ children }: { children: React.ReactNode }) => children,
  iconButtonChromeGlyphSize: () => 16,
  mutedIconColorMapping: () => ({}),
}));
vi.mock("@/components/ui/edge-fade", () => ({ EdgeFade: () => null }));
vi.mock("@/screens/workspace/workspace-explorer-toggle", () => ({
  EXPLORER_TOGGLE_KEYS: [],
  WorkspaceExplorerToggle: () => null,
}));
vi.mock("@/screens/workspace/workspace-header-project-row", () => ({
  WorkspaceHeaderProjectRow: () => null,
}));
vi.mock("./tab-switcher", () => ({ MobileWorkspaceTabSwitcher: () => null }));

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const NOOP = () => {};
const COLLAPSED = { expanded: false };

function header(accent: "teal" | "red" | null) {
  return (
    <CompactWorkspaceHeader
      serverId="host"
      workspaceId="w1"
      isLoading={false}
      title="Workspace"
      subtitle="project"
      isSubtitleDistinct
      accent={accent}
      onToggleExplorer={NOOP}
      explorerToggleLabel="Explorer"
      explorerToggleAccessibilityState={COLLAPSED}
    >
      {null}
    </CompactWorkspaceHeader>
  );
}

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function chrome(host: HTMLElement): HTMLElement | null {
  return host.querySelector("[data-testid='workspace-accent-chrome']");
}

describe("compact workspace header accent", () => {
  it("paints the workspace's accent behind the header", () => {
    const host = render(header("teal"));
    expect(chrome(host)).not.toBeNull();
  });

  it("paints nothing without an accent", () => {
    expect(chrome(render(header(null)))).toBeNull();
  });

  it("swaps the accent when the workspace's color changes", () => {
    const host = render(header("teal"));
    const tint = () => chrome(host)?.firstElementChild?.getAttribute("style");
    const before = tint();
    act(() => root?.render(header("red")));
    expect(tint()).not.toBe(before);
  });

  it.each([false, true])(
    "keeps the accent when the header floats over content (%s)",
    (floating) => {
      const host = render(
        <FloatingHeaderLayout header={header("teal")} floating={floating}>
          {() => null}
        </FloatingHeaderLayout>,
      );
      expect(chrome(host)).not.toBeNull();
    },
  );
});
