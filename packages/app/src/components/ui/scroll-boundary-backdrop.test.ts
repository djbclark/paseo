import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR_NAMES, identityColor, identityTint } from "@/styles/identity-colors";
import { darkTheme, lightTheme } from "@/styles/theme";
import { scrollBoundaryBackdropColor } from "./scroll-boundary-backdrop";

describe("scrollBoundaryBackdropColor", () => {
  it("is today's rail color when the row has no tint", () => {
    for (const { colors } of [lightTheme, darkTheme]) {
      expect(scrollBoundaryBackdropColor(colors, "surface", undefined)).toBe(colors.surface0);
      expect(scrollBoundaryBackdropColor(colors, "sidebar", undefined)).toBe(colors.surfaceSidebar);
    }
  });

  it("is the rail color with the tint composited, in light and dark", () => {
    // Pixels the row shows in the headless render: light (247,239,239), dark (39,34,33).
    expect(scrollBoundaryBackdropColor(lightTheme.colors, "surface", "red")).toBe("#f7efef");
    expect(scrollBoundaryBackdropColor(darkTheme.colors, "surface", "red")).toBe("#272221");
  });

  it("composites at the alpha the tint itself carries, for every identity color", () => {
    for (const colors of [lightTheme.colors, darkTheme.colors]) {
      for (const name of IDENTITY_COLOR_NAMES) {
        const alpha = Number.parseInt(identityTint(name).slice(7, 9), 16) / 255;
        const surface = colors.surface0;
        const expected = [1, 3, 5].map((start) => {
          const under = Number.parseInt(surface.slice(start, start + 2), 16);
          const over = Number.parseInt(identityColor(name).slice(start, start + 2), 16);
          return under * (1 - alpha) + over * alpha;
        });
        const actual = scrollBoundaryBackdropColor(colors, "surface", name);
        const actualChannels = [1, 3, 5].map((start) =>
          Number.parseInt(actual.slice(start, start + 2), 16),
        );
        expect(actual).toMatch(/^#[0-9a-f]{6}$/);
        actualChannels.forEach((channel, index) =>
          expect(Math.abs(channel - expected[index])).toBeLessThanOrEqual(0.5),
        );
      }
    }
  });
});
