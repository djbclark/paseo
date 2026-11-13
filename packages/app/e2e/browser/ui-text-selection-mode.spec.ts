import type { JSHandle, Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { clickNewTerminal, getActiveTabTestId, getTabTestIds } from "../support/helpers/launcher";
import {
  composerLocator,
  expectComposerEditable,
  expectComposerFocused,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { closeWorkspaceContextMenu, openWorkspaceContextMenu } from "../support/helpers/sidebar";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// The constants module is written in parallel with this spec, so the attribute is spelled out.
const SELECTION_MODE_ATTRIBUTE = "data-paseo-ui-select";
const AGENT_TAB_TITLE = "Select mode tab alpha";
const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

interface SelectionModeFixture {
  /** The workspace the page is open on; its agent tab is the tab under test. */
  agentId: string;
  workspaceId: string;
  /** A second workspace listed in the sidebar; clicking its row would switch to it. */
  otherWorkspaceId: string;
  cleanup(): Promise<void>;
}

async function seedSelectionModeFixture(page: Page): Promise<SelectionModeFixture> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "ui-select-mode-",
    title: AGENT_TAB_TITLE,
    initialPrompt: "Say hello.",
  });
  let other: Awaited<ReturnType<typeof seedWorkspace>> | null = null;
  try {
    other = await seedWorkspace({ repoPrefix: "ui-select-mode-other-" });
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);
    await waitForWorkspaceTabsVisible(page);
    await expect(sidebarWorkspaceTitle(page, other.workspaceId)).toBeVisible({ timeout: 30_000 });
    await blurActiveElement(page);
    return {
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      otherWorkspaceId: other.workspaceId,
      cleanup: async () => {
        await other?.cleanup();
        await agent.cleanup();
      },
    };
  } catch (error) {
    await other?.cleanup();
    await agent.cleanup();
    throw error;
  }
}

function sidebarWorkspaceTitle(page: Page, workspaceId: string): Locator {
  return page
    .getByTestId(`sidebar-workspace-title-${getServerId()}:${workspaceId}`)
    .filter({ visible: true })
    .first();
}

function agentTab(page: Page, agentId: string): Locator {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

function htmlElement(page: Page): Locator {
  return page.locator("html");
}

async function expectSelectionModeOn(page: Page): Promise<void> {
  await expect(htmlElement(page)).toHaveAttribute(SELECTION_MODE_ATTRIBUTE, "");
}

async function expectSelectionModeOff(page: Page): Promise<void> {
  await expect(htmlElement(page)).not.toHaveAttribute(SELECTION_MODE_ATTRIBUTE);
}

/** Take focus off the composer, which autofocuses and would otherwise suppress the mode. */
async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Shift down with focus guaranteed off the composer, which can autofocus late. */
async function pressShift(page: Page): Promise<void> {
  await blurActiveElement(page);
  await page.keyboard.down("Shift");
}

/** One entry per `contextmenu` event that reaches the window, whatever the page does with it. */
async function watchContextMenus(page: Page): Promise<JSHandle<number[]>> {
  return page.evaluateHandle(() => {
    const seen: number[] = [];
    window.addEventListener("contextmenu", () => seen.push(1), true);
    return seen;
  });
}

async function readSelection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** Two animation frames: lets any handler a key press scheduled run before an absence check. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Hold Shift and drag the pointer across `target`'s text, from its first glyph to its last.
 * Leaves Shift down and the button up; the caller releases Shift. A selection left from before is
 * not cleared here: the mode itself must start the new drag fresh.
 */
async function shiftDragAcross(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) {
    throw new Error("Expected the drag target to be laid out");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await pressShift(page);
  await expectSelectionModeOn(page);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 12 });
  await page.mouse.up();
}

test.describe("UI text selection mode", () => {
  // Contract item 1: Shift alone turns the mode on; releasing it with nothing selected turns it off.
  test("holding Shift sets the attribute and releasing it with no selection clears it", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await expectSelectionModeOff(page);

      await pressShift(page);
      await expectSelectionModeOn(page);
      // The mode's stylesheet makes chrome that is normally unselectable selectable.
      await expect(sidebarWorkspaceTitle(page, fixture.otherWorkspaceId)).toHaveCSS(
        "user-select",
        "text",
      );

      await page.keyboard.up("Shift");
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 2: a Shift-drag across a sidebar row title selects the text and does not navigate.
  test("Shift-dragging across a sidebar workspace title selects it without switching workspace", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);
      const titleText = (await title.innerText()).trim();
      expect(titleText).not.toBe("");
      const urlBefore = page.url();

      await shiftDragAcross(page, title);

      expect(await readSelection(page)).toContain(titleText);
      expect(page.url()).toBe(urlBefore);
      await expect(agentTab(page, fixture.agentId)).toHaveAttribute("aria-selected", "true");
      // The route did not move to the other workspace either after a settle.
      await settleFrames(page);
      expect(page.url()).toBe(urlBefore);
      expect(page.url()).toContain(fixture.workspaceId);
      expect(page.url()).not.toContain(fixture.otherWorkspaceId);

      await page.keyboard.up("Shift");
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 3: a Shift-drag across a desktop tab title selects it, and leaves the tab strip alone.
  test("Shift-dragging across a desktop tab title selects it without activating or reordering tabs", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      // A new terminal becomes the active tab, so a click on the agent tab would visibly switch.
      await clickNewTerminal(page);
      await expect(
        page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }),
      ).toHaveCount(1, { timeout: 30_000 });
      const tab = agentTab(page, fixture.agentId);
      await expect(tab).toHaveAttribute("aria-selected", "false");
      const tabOrderBefore = await getTabTestIds(page);
      const activeTabBefore = await getActiveTabTestId(page);
      expect(activeTabBefore).not.toBeNull();
      expect(activeTabBefore).not.toBe(`workspace-tab-agent_${fixture.agentId}`);

      await shiftDragAcross(page, tab.getByText(AGENT_TAB_TITLE, { exact: false }).first());

      expect(await readSelection(page)).toContain(AGENT_TAB_TITLE);
      await settleFrames(page);
      expect(await getTabTestIds(page)).toEqual(tabOrderBefore);
      expect(await getActiveTabTestId(page)).toBe(activeTabBefore);
      await expect(tab).toHaveAttribute("aria-selected", "false");

      await page.keyboard.up("Shift");
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 4 (amendment 1): the mode latches after Shift is released over a selection,
  // copies, and a plain click elsewhere (which collapses the selection) ends it. Escape is not a trigger.
  test("a selection latches the mode after Shift is released, copies, and a plain click clears it", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fixture = await seedSelectionModeFixture(page);
    try {
      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);
      const titleText = (await title.innerText()).trim();

      await shiftDragAcross(page, title);
      expect(await readSelection(page)).toContain(titleText);

      await page.keyboard.up("Shift");
      await settleFrames(page);
      await expectSelectionModeOn(page);
      expect(await readSelection(page)).toContain(titleText);

      await page.keyboard.press(`${MODIFIER}+c`);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(titleText);

      // Escape is the global interrupt shortcut, so it must not end the mode.
      await page.keyboard.press("Escape");
      await settleFrames(page);
      await expectSelectionModeOn(page);

      // The active agent tab: clicking it changes nothing, but it collapses the selection.
      await agentTab(page, fixture.agentId)
        .getByText(AGENT_TAB_TITLE, { exact: false })
        .first()
        .click();
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 4 (amendment 1, A8): a latched mode leaves the app's context menus closed so the
  // native menu can offer Copy.
  test("right-clicking a latched selection does not open the app's workspace context menu", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const workspaceKey = `${getServerId()}:${fixture.otherWorkspaceId}`;
      const appMenu = page.getByTestId(`sidebar-workspace-context-menu-${workspaceKey}`);
      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);

      // Positive control: with the mode off, a right-click on the row opens the app's menu.
      await openWorkspaceContextMenu(page, fixture.otherWorkspaceId);
      await expect(appMenu).toBeVisible();
      await closeWorkspaceContextMenu(page, fixture.otherWorkspaceId);
      await expect(appMenu).toHaveCount(0);

      await shiftDragAcross(page, title);
      await page.keyboard.up("Shift");
      await settleFrames(page);
      await expectSelectionModeOn(page);
      expect((await readSelection(page)).length).toBeGreaterThan(0);

      // The right-click must reach the page (positive signal), keep the mode and selection, and
      // leave the app's menu closed for longer than it takes the menu to mount.
      const contextMenusSeen = await watchContextMenus(page);
      await title.click({ button: "right" });
      expect(await contextMenusSeen.evaluate((seen) => seen.length)).toBe(1);
      await expectSelectionModeOn(page);
      expect((await readSelection(page)).length).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      await expect(appMenu).toHaveCount(0);
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 4 (amendment 1, A8): a latched mode does not swallow clicks.
  test("a plain click on a sidebar workspace row navigates while the mode is latched", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);
      await shiftDragAcross(page, title);
      await page.keyboard.up("Shift");
      await settleFrames(page);
      await expectSelectionModeOn(page);
      expect(page.url()).not.toContain(fixture.otherWorkspaceId);

      await page
        .getByTestId(`sidebar-workspace-row-${getServerId()}:${fixture.otherWorkspaceId}`)
        .filter({ visible: true })
        .first()
        .click();

      await expect(page).toHaveURL(new RegExp(fixture.otherWorkspaceId), { timeout: 30_000 });
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });

  // Review fix: a Shift-drag starts a new selection instead of extending an earlier one.
  test("a Shift-drag replaces an earlier selection instead of extending it", async ({ page }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const tabTitle = agentTab(page, fixture.agentId)
        .getByText(AGENT_TAB_TITLE, { exact: false })
        .first();
      await shiftDragAcross(page, tabTitle);
      await page.keyboard.up("Shift");
      expect(await readSelection(page)).toContain(AGENT_TAB_TITLE);

      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);
      const titleText = (await title.innerText()).trim();
      await shiftDragAcross(page, title);
      await page.keyboard.up("Shift");

      const selection = await readSelection(page);
      expect(selection).toContain(titleText);
      expect(selection).not.toContain(AGENT_TAB_TITLE);
      expect(page.url()).not.toContain(fixture.otherWorkspaceId);
    } finally {
      await fixture.cleanup();
    }
  });

  // Review fix: pressing Shift again while latched blocks clicks again.
  test("a second Shift-drag while latched still does not switch workspace", async ({ page }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const tabTitle = agentTab(page, fixture.agentId)
        .getByText(AGENT_TAB_TITLE, { exact: false })
        .first();
      await shiftDragAcross(page, tabTitle);
      await page.keyboard.up("Shift");
      await expectSelectionModeOn(page);

      await shiftDragAcross(page, sidebarWorkspaceTitle(page, fixture.otherWorkspaceId));
      await settleFrames(page);

      expect(page.url()).not.toContain(fixture.otherWorkspaceId);
      await page.keyboard.up("Shift");
    } finally {
      await fixture.cleanup();
    }
  });

  // Review fix: releasing Shift before the button must not let the drag's click through.
  test("releasing Shift before the mouse button does not switch workspace", async ({ page }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const title = sidebarWorkspaceTitle(page, fixture.otherWorkspaceId);
      const box = await title.boundingBox();
      if (!box) {
        throw new Error("Expected the drag target to be laid out");
      }
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 1, y);
      await pressShift(page);
      await expectSelectionModeOn(page);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, y, { steps: 12 });
      await page.keyboard.up("Shift");
      await page.mouse.up();
      await settleFrames(page);

      expect(page.url()).not.toContain(fixture.otherWorkspaceId);
      expect(await readSelection(page)).toContain((await title.innerText()).trim());
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 5: Cmd/Ctrl+Shift shortcuts run their action; Shift does not swallow them.
  test("Cmd/Ctrl+Shift+F still enters focus mode and leaves the selection mode off", async ({
    page,
  }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      const exitFocusMode = page.getByRole("button", { name: "Exit focus mode" });
      await expect(exitFocusMode).toHaveCount(0);

      await page.keyboard.press(`${MODIFIER}+Shift+F`);

      await expect(exitFocusMode).toBeVisible();
      await settleFrames(page);
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 6: focus in the composer keeps Shift for typing capitals and selecting text.
  test("Shift does not turn the mode on while the composer is focused", async ({ page }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      // Positive control: with nothing focused, Shift does turn the mode on.
      await pressShift(page);
      await expectSelectionModeOn(page);
      await page.keyboard.up("Shift");
      await expectSelectionModeOff(page);

      await expectComposerEditable(page);
      await composerLocator(page).click();
      await expectComposerFocused(page);

      await page.keyboard.down("Shift");
      await settleFrames(page);
      await expectSelectionModeOff(page);
      await page.keyboard.up("Shift");
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });

  // Contract item 7: losing window focus turns a held mode off, so it cannot stick on.
  test("a window blur clears the mode while Shift is held", async ({ page }) => {
    const fixture = await seedSelectionModeFixture(page);
    try {
      await pressShift(page);
      await expectSelectionModeOn(page);

      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expectSelectionModeOff(page);

      await page.keyboard.up("Shift");
      await expectSelectionModeOff(page);
    } finally {
      await fixture.cleanup();
    }
  });
});
