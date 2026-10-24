import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  WORKSPACE_ACCENT_FILL_STYLES,
  WORKSPACE_ACCENT_TINT_STYLES,
  type WorkspaceAccent,
} from "./model";

export const WORKSPACE_ACCENT_STRIPE_HEIGHT = 2;

/**
 * The workspace's identity color over a strip of chrome: a 10% tint and, when `stripe` is set, a
 * 2px stripe on the top edge. Only the outermost strip carries the stripe, so the header's stripe
 * and the tab row's never stack into a double rule. It is an overlay so the strip's own registered styles stay untouched, and it must sit
 * under the strip's content (first child) and never on a Reanimated view — see docs/unistyles.md.
 * Render nothing when there is no accent.
 */
export function WorkspaceAccentChrome({
  accent,
  stripe,
}: {
  accent: WorkspaceAccent | null;
  stripe: boolean;
}): ReactElement | null {
  if (!accent) return null;
  return (
    <View
      style={styles.frame}
      testID="workspace-accent-chrome"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.tint, WORKSPACE_ACCENT_TINT_STYLES[accent]]} />
      {stripe ? <View style={[styles.stripe, WORKSPACE_ACCENT_FILL_STYLES[accent]]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
  tint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  stripe: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: WORKSPACE_ACCENT_STRIPE_HEIGHT,
  },
}));
