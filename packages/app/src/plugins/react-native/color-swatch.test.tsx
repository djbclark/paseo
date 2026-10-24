import { View } from "react-native";
import { describe, expect, it } from "vitest";
import type { PluginIdentityColor } from "@getpaseo/plugin/client";
import { WORKSPACE_ACCENT_FILL_STYLES } from "@/workspace-accent/model";
import { ColorSwatch } from "./color-swatch";

describe("ColorSwatch", () => {
  it("fills a round chip with the identity color", () => {
    const element = ColorSwatch({ color: "teal", size: 20, testID: "swatch" });
    expect(element).toMatchObject({ type: View, props: { testID: "swatch" } });
    expect(element?.props.style).toEqual([
      { width: 20, height: 20, borderRadius: 10 },
      WORKSPACE_ACCENT_FILL_STYLES.teal,
      false,
    ]);
  });

  it("defaults to 16 and adds a ring only when selected", () => {
    const plain = ColorSwatch({ color: "red" });
    const selected = ColorSwatch({ color: "red", selected: true });
    expect(plain?.props.style[0]).toEqual({ width: 16, height: 16, borderRadius: 8 });
    expect(plain?.props.style[2]).toBe(false);
    expect(selected?.props.style[2]).toBeTruthy();
  });

  it("renders nothing for an unknown color name", () => {
    expect(ColorSwatch({ color: "magenta" as PluginIdentityColor })).toBeNull();
  });
});
