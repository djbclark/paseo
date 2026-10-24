import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ColorSwatchProps } from "@getpaseo/plugin/client/ui";
import { WORKSPACE_ACCENT_FILL_STYLES, isWorkspaceAccent } from "@/workspace-accent/model";

const DEFAULT_SIZE = 16;

/** A round, non-pressable chip of an identity color, for menu icons and settings rows. */
export function ColorSwatch({
  color,
  selected = false,
  size = DEFAULT_SIZE,
  testID,
}: ColorSwatchProps) {
  if (!isWorkspaceAccent(color)) return null;
  return (
    <View
      testID={testID}
      style={[
        { width: size, height: size, borderRadius: size / 2 },
        WORKSPACE_ACCENT_FILL_STYLES[color],
        selected && styles.selected,
      ]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  selected: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.foreground,
  },
}));
