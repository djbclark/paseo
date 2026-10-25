import { identityTintOver, type IdentityColorName } from "@/styles/identity-colors";

export type ScrollBoundaryBackdrop = "surface" | "sidebar";

/**
 * The opaque color a scroll-edge fade ramps to: the rail's surface, with the workspace tint
 * composited when the rail carries one. Opaque, so the fade still hides what scrolls under it.
 */
export function scrollBoundaryBackdropColor(
  colors: { surface0: string; surfaceSidebar: string },
  backdrop: ScrollBoundaryBackdrop,
  tint: IdentityColorName | null | undefined,
): string {
  const surface = backdrop === "sidebar" ? colors.surfaceSidebar : colors.surface0;
  return tint ? identityTintOver(tint, surface) : surface;
}
