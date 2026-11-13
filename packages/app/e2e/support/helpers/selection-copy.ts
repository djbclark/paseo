import type { Locator, Page } from "@playwright/test";

interface TextDragOptions {
  start: string;
  end: string;
  releaseShiftDuringDrag?: boolean;
}

export async function shiftDragText(page: Page, root: Locator, options: TextDragOptions) {
  await root.scrollIntoViewIfNeeded();
  const points = await root.evaluate((element, { start, end }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (node instanceof Text) nodes.push(node);
      node = walker.nextNode();
    }
    const text = nodes.map((item) => item.data).join("");
    const startOffset = text.indexOf(start);
    const endOffset = text.indexOf(end, startOffset) + end.length;
    if (startOffset < 0 || endOffset < end.length) throw new Error("Drag text not found");
    function character(offset: number) {
      for (const textNode of nodes) {
        if (offset >= textNode.length) {
          offset -= textNode.length;
          continue;
        }
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.setEnd(textNode, offset + 1);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      throw new Error("Drag boundary not found");
    }
    return { first: character(startOffset), last: character(endOffset - 1) };
  }, options);
  await page.keyboard.down("Shift");
  try {
    await page.mouse.move(points.first.left + 0.1, points.first.y);
    await page.mouse.down();
    await page.mouse.move(points.last.right + 0.1, points.last.y, { steps: 12 });
    if (options.releaseShiftDuringDrag) await page.keyboard.up("Shift");
    await page.mouse.up();
  } finally {
    await page.keyboard.up("Shift");
  }
}
