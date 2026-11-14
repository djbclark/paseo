import { findTextMatchOffsets, MAX_WINDOW_SEARCH_MATCHES } from "./window-search-match";

const HIGHLIGHT_NAME = "paseo-window-search";
const ACTIVE_HIGHLIGHT_NAME = "paseo-window-search-active";
const STYLE_ID = "paseo-window-search-styles";
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);

export function installWindowSearchHighlightStyles(): () => void {
  if (typeof document === "undefined") return () => {};
  const existing = document.getElementById(STYLE_ID);
  if (existing) return () => {};

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(250, 204, 21, 0.38);
  color: inherit;
}

::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
  background-color: rgba(249, 115, 22, 0.72);
  color: inherit;
}
`;
  document.head.append(style);
  return () => style.remove();
}

function isElementVisible(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (SKIPPED_TAGS.has(element.tagName)) return false;
  if (element.closest('[data-window-search-bar="true"]')) return false;
  const checkVisibility = (
    element as HTMLElement & { checkVisibility?: (options?: Record<string, boolean>) => boolean }
  ).checkVisibility;
  if (typeof checkVisibility === "function") {
    return checkVisibility.call(element, { checkOpacity: false, checkVisibilityCSS: true });
  }
  return element.offsetParent !== null || getComputedStyle(element).position === "fixed";
}

/**
 * Collect DOM `Range` objects for every visible text match under `root`.
 */
export function collectWindowSearchRanges(
  root: HTMLElement | null,
  query: string,
  maxMatches: number = MAX_WINDOW_SEARCH_MATCHES,
): Range[] {
  if (!root || !query.trim() || typeof document === "undefined") return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return isElementVisible(node.parentElement)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode && ranges.length < maxMatches) {
    const text = currentNode.nodeValue ?? "";
    const offsets = findTextMatchOffsets(text, query, maxMatches - ranges.length);
    for (const offset of offsets) {
      const range = document.createRange();
      range.setStart(currentNode, offset.start);
      range.setEnd(currentNode, offset.end);
      ranges.push(range);
    }
    currentNode = walker.nextNode();
  }

  return ranges;
}

function getCssHighlights(): {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
} | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  const registry = (CSS as unknown as { highlights?: unknown }).highlights;
  if (!registry || typeof registry !== "object") return null;
  return registry as {
    set: (name: string, highlight: unknown) => void;
    delete: (name: string) => void;
  };
}

export function applyWindowSearchHighlights(ranges: Range[], activeIndex: number): void {
  const registry = getCssHighlights();
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
    .Highlight;
  if (!registry || !HighlightCtor) return;

  if (ranges.length === 0) {
    registry.delete(HIGHLIGHT_NAME);
    registry.delete(ACTIVE_HIGHLIGHT_NAME);
    return;
  }

  registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
  const activeRange = ranges[activeIndex];
  if (activeRange) {
    registry.set(ACTIVE_HIGHLIGHT_NAME, new HighlightCtor(activeRange));
  } else {
    registry.delete(ACTIVE_HIGHLIGHT_NAME);
  }
}

export function clearWindowSearchHighlights(): void {
  const registry = getCssHighlights();
  if (!registry) return;
  registry.delete(HIGHLIGHT_NAME);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

export function scrollWindowSearchRangeIntoView(range: Range | undefined): void {
  if (!range) return;
  const parent = range.startContainer.parentElement;
  parent?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
}
