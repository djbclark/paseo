import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SELECTION_MODE_ATTRIBUTE, SELECTION_MODE_STYLE_ID } from "./constants";
import { installSelectionMode } from "./install-selection-mode.web";

let uninstall: () => void;

beforeEach(() => {
  uninstall = installSelectionMode();
});

afterEach(() => {
  uninstall();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function isOn(): boolean {
  return document.documentElement.hasAttribute(SELECTION_MODE_ATTRIBUTE);
}

function press(type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }));
}

function selectContents(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function appendUnselectable(): HTMLElement {
  const style = document.createElement("style");
  style.textContent = ".no-select { user-select: none; -webkit-user-select: none; }";
  const byClass = document.createElement("div");
  byClass.className = "no-select";
  byClass.textContent = "class rule";
  const byInline = document.createElement("div");
  byInline.style.userSelect = "none";
  byInline.textContent = "inline style";
  const wrapper = document.createElement("div");
  wrapper.append(style, byClass, byInline);
  document.body.append(wrapper);
  return wrapper;
}

it("injects its stylesheet once and removes it on uninstall", () => {
  expect(document.querySelectorAll(`#${SELECTION_MODE_STYLE_ID}`)).toHaveLength(1);
  uninstall();
  expect(document.getElementById(SELECTION_MODE_STYLE_ID)).toBeNull();
  uninstall = installSelectionMode();
});

it("turns on while Shift is down and off when released with no selection", () => {
  press("keydown", "Shift");
  expect(isOn()).toBe(true);
  press("keyup", "Shift");
  expect(isOn()).toBe(false);
});

it("overrides user-select: none from a class rule and an inline style", () => {
  const wrapper = appendUnselectable();
  const [, byClass, byInline] = Array.from(wrapper.children);
  expect(getComputedStyle(byClass).userSelect).toBe("none");
  expect(getComputedStyle(byInline).userSelect).toBe("none");
  press("keydown", "Shift");
  expect(getComputedStyle(byClass).userSelect).toBe("text");
  expect(getComputedStyle(byInline).userSelect).toBe("text");
});

function collapseSelection(): Promise<void> {
  const changed = new Promise<void>((resolve) =>
    document.addEventListener("selectionchange", () => resolve(), { once: true }),
  );
  window.getSelection()?.removeAllRanges();
  return changed;
}

function appendParagraph(): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.textContent = "some text";
  document.body.append(paragraph);
  return paragraph;
}

it("keeps the selection range, but not its text, once user-select flips back to none", () => {
  const wrapper = appendUnselectable();
  const byClass = wrapper.children[1];
  press("keydown", "Shift");
  selectContents(byClass);
  press("keyup", "Shift");
  expect(isOn()).toBe(true);
  expect(window.getSelection()?.toString()).toBe("class rule");
  window.dispatchEvent(new Event("blur"));
  expect(isOn()).toBe(false);
  expect(getComputedStyle(byClass).userSelect).toBe("none");
  expect(window.getSelection()?.isCollapsed).toBe(false);
  expect(window.getSelection()?.toString()).toBe("");
});

it("latches over a selection and ignores Escape", () => {
  const paragraph = appendParagraph();
  press("keydown", "Shift");
  selectContents(paragraph);
  press("keyup", "Shift");
  expect(isOn()).toBe(true);
  press("keydown", "Escape", { shiftKey: false });
  expect(isOn()).toBe(true);
});

it("releases a latched mode when the selection collapses", async () => {
  const paragraph = appendParagraph();
  press("keydown", "Shift");
  selectContents(paragraph);
  press("keyup", "Shift");
  await collapseSelection();
  expect(isOn()).toBe(false);
});

it("releases a latched mode when Shift is pressed again and released with no selection", () => {
  const paragraph = appendParagraph();
  press("keydown", "Shift");
  selectContents(paragraph);
  press("keyup", "Shift");
  press("keydown", "Shift");
  window.getSelection()?.removeAllRanges();
  press("keyup", "Shift");
  expect(isOn()).toBe(false);
});

it("releases when the page becomes hidden", () => {
  press("keydown", "Shift");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  visibility.mockRestore();
  expect(isOn()).toBe(false);
});

it("releases a held mode on a pointermove that reports Shift up", () => {
  press("keydown", "Shift");
  window.dispatchEvent(new PointerEvent("pointermove", { shiftKey: true }));
  expect(isOn()).toBe(true);
  window.dispatchEvent(new PointerEvent("pointermove", { shiftKey: false }));
  expect(isOn()).toBe(false);
});

it("releases a held mode on a keydown that reports Shift up", () => {
  press("keydown", "Shift");
  press("keydown", "a", { shiftKey: false });
  expect(isOn()).toBe(false);
});

it("makes title-bar drag regions selectable", () => {
  const region = document.createElement("div");
  region.style.setProperty("-webkit-app-region", "drag");
  document.body.append(region);
  press("keydown", "Shift");
  expect(getComputedStyle(region).getPropertyValue("-webkit-app-region")).toBe("no-drag");
});

it("releases on window blur", () => {
  press("keydown", "Shift");
  window.dispatchEvent(new Event("blur"));
  expect(isOn()).toBe(false);
});

it("leaves a Meta+Shift shortcut alone", () => {
  press("keydown", "Meta", { metaKey: true });
  press("keydown", "Shift", { metaKey: true, shiftKey: true });
  press("keydown", "x", { metaKey: true, shiftKey: true });
  expect(isOn()).toBe(false);
});

it("does not turn on when Shift goes down in a text input", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  press("keydown", "Shift");
  expect(isOn()).toBe(false);
});

it("does not turn on when Shift goes down inside an xterm container", () => {
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const inner = document.createElement("textarea");
  terminal.append(inner);
  document.body.append(terminal);
  inner.focus();
  press("keydown", "Shift");
  expect(isOn()).toBe(false);
});

it("stops pointer events from reaching the page and blocks link clicks while on", () => {
  const link = document.createElement("a");
  link.href = "#navigated";
  link.textContent = "link";
  document.body.append(link);
  const reached: string[] = [];
  document.body.addEventListener("pointerdown", () => reached.push("pointerdown"));
  document.body.addEventListener("click", () => reached.push("click"));

  press("keydown", "Shift");
  const pointerdown = new Event("pointerdown", { bubbles: true, cancelable: true });
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(pointerdown);
  link.dispatchEvent(click);

  expect(reached).toEqual([]);
  expect(pointerdown.defaultPrevented).toBe(false);
  expect(click.defaultPrevented).toBe(true);
});

it("lets pointer events through when off and for editable targets", () => {
  const input = document.createElement("input");
  document.body.append(input);
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));

  input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  press("keydown", "Shift");
  input.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(reached).toEqual(["click", "click"]);
});

it("prevents native drags while on", () => {
  const image = document.createElement("img");
  document.body.append(image);
  press("keydown", "Shift");
  const dragstart = new Event("dragstart", { bubbles: true, cancelable: true });
  image.dispatchEvent(dragstart);
  expect(dragstart.defaultPrevented).toBe(true);
});

it("lets pointer events through once latched", () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));
  press("keydown", "Shift");
  selectContents(paragraph);
  press("keyup", "Shift");

  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  paragraph.dispatchEvent(click);

  expect(reached).toEqual(["click"]);
  expect(click.defaultPrevented).toBe(false);
});

it("stops the app's context menu over a selection without cancelling the native one", () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("contextmenu", () => reached.push("contextmenu"));
  press("keydown", "Shift");
  selectContents(paragraph);
  press("keyup", "Shift");

  const contextmenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  paragraph.dispatchEvent(contextmenu);

  expect(reached).toEqual([]);
  expect(contextmenu.defaultPrevented).toBe(false);
});

it("leaves the context menu alone when nothing is selected", () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("contextmenu", () => reached.push("contextmenu"));
  press("keydown", "Shift");
  paragraph.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(reached).toEqual(["contextmenu"]);
});

it("sees keys before a later window-capture listener that swallows them", () => {
  const swallow = (event: KeyboardEvent) => event.stopImmediatePropagation();
  window.addEventListener("keydown", swallow, true);
  press("keydown", "Shift");
  window.removeEventListener("keydown", swallow, true);
  expect(isOn()).toBe(true);
});
