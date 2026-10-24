import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WORKSPACE_ACCENT_FILL_STYLES, type WorkspaceAccent } from "./model";

const DESKTOP_BAR_HEIGHT = 2;
const DESKTOP_BAR_BOTTOM = 3;
const MOBILE_BAR_WIDTH = 3;
const MOBILE_BAR_HEIGHT = 16;

/**
 * A colored tab's mark on a desktop chip: a 2px bar inside the chip's bottom edge, between its
 * horizontal paddings. Absolute, so it never enters the width `layoutMetrics` measures. Visible
 * whether or not the tab is active.
 */
export function TabAccentBottomBar({
  accent,
  inset,
}: {
  accent: WorkspaceAccent;
  /** The chip's horizontal padding, so the bar spans exactly the chip's content. */
  inset: number;
}): ReactElement {
  return (
    <View
      style={[
        styles.bottomBar,
        { left: inset, right: inset },
        WORKSPACE_ACCENT_FILL_STYLES[accent],
      ]}
      testID="workspace-tab-accent-bar"
    />
  );
}

/** A colored tab's mark in a phone tab row: a 3x16 bar in the row's leading padding. */
export function TabAccentLeadingBar({ accent }: { accent: WorkspaceAccent }): ReactElement {
  return (
    <View
      style={[styles.leadingBar, WORKSPACE_ACCENT_FILL_STYLES[accent]]}
      testID="workspace-tab-accent-bar"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  bottomBar: {
    position: "absolute",
    bottom: DESKTOP_BAR_BOTTOM,
    height: DESKTOP_BAR_HEIGHT,
    borderRadius: theme.borderRadius.full,
    pointerEvents: "none",
  },
  leadingBar: {
    position: "absolute",
    left: 0,
    top: "50%",
    marginTop: -MOBILE_BAR_HEIGHT / 2,
    width: MOBILE_BAR_WIDTH,
    height: MOBILE_BAR_HEIGHT,
    borderRadius: theme.borderRadius.full,
    pointerEvents: "none",
  },
}));
