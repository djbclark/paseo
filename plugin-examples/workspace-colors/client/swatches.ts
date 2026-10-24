import type { PluginButtonIconProps, PluginIdentityColor } from "@getpaseo/plugin/client";
import { ColorSwatch } from "@getpaseo/plugin/client/ui";
import { createElement, type ComponentType } from "react";
import { COLORS } from "../shared/colors";

function swatchIcon(color: PluginIdentityColor, selected: boolean) {
  const Icon = ({ size }: PluginButtonIconProps) =>
    createElement(ColorSwatch, { color, selected, size });
  Icon.displayName = `${color}${selected ? "Selected" : ""}Swatch`;
  return Icon;
}

// Menu icons are components, so build them once; a fresh component each render would remount.
const icons = Object.fromEntries(
  COLORS.map((color) => [
    color,
    { plain: swatchIcon(color, false), selected: swatchIcon(color, true) },
  ]),
) as Record<
  PluginIdentityColor,
  { plain: ComponentType<PluginButtonIconProps>; selected: ComponentType<PluginButtonIconProps> }
>;

export function swatchFor(color: PluginIdentityColor, selected: boolean) {
  return selected ? icons[color].selected : icons[color].plain;
}
