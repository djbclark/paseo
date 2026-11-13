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

function nextSelectionChange(): Promise<void> {
  return new Promise((resolve) =>
    document.addEventListener("selectionchange", () => resolve(), { once: true }),
  );
}

async function selectContents(element: Element): Promise<void> {
  const changed = nextSelectionChange();
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await changed;
}

async function collapseSelection(): Promise<void> {
  const changed = nextSelectionChange();
  window.getSelection()?.removeAllRanges();
  await changed;
}

function appendParagraph(text = "some text"): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  document.body.append(paragraph);
  return paragraph;
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

async function latchOver(element: Element): Promise<void> {
  press("keydown", "Shift");
  await selectContents(element);
  press("keyup", "Shift");
}

function pointerdown(target: Element, init: PointerEventInit = {}): PointerEvent {
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("injects its stylesheet once and installs once", () => {
  expect(installSelectionMode()).toBe(uninstall);
  expect(document.querySelectorAll(`#${SELECTION_MODE_STYLE_ID}`)).toHaveLength(1);
  uninstall();
  expect(document.getElementById(SELECTION_MODE_STYLE_ID)).toBeNull();
  uninstall = installSelectionMode();
  expect(document.querySelectorAll(`#${SELECTION_MODE_STYLE_ID}`)).toHaveLength(1);
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

it("keeps the selection range, but not its text, once user-select flips back to none", async () => {
  const wrapper = appendUnselectable();
  const byClass = wrapper.children[1];
  await latchOver(byClass);
  expect(isOn()).toBe(true);
  expect(window.getSelection()?.toString()).toBe("class rule");
  window.dispatchEvent(new Event("blur"));
  expect(isOn()).toBe(false);
  expect(getComputedStyle(byClass).userSelect).toBe("none");
  expect(window.getSelection()?.isCollapsed).toBe(false);
  expect(window.getSelection()?.toString()).toBe("");
});

it("latches over a selection and ignores Escape", async () => {
  await latchOver(appendParagraph());
  expect(isOn()).toBe(true);
  press("keydown", "Escape", { shiftKey: false });
  expect(isOn()).toBe(true);
});

it("latches instead of dropping the text when Meta goes down before Shift is released", async () => {
  const wrapper = appendUnselectable();
  press("keydown", "Shift");
  await selectContents(wrapper.children[1]);
  press("keydown", "Meta", { metaKey: true, shiftKey: true });
  expect(isOn()).toBe(true);
  press("keyup", "Shift", { metaKey: true });
  expect(window.getSelection()?.toString()).toBe("class rule");
});

it("does not latch when Shift is tapped over an unrelated selection", async () => {
  await selectContents(appendParagraph());
  press("keydown", "Shift");
  press("keyup", "Shift");
  expect(isOn()).toBe(false);
});

it("releases a latched mode when the selection collapses", async () => {
  await latchOver(appendParagraph());
  await collapseSelection();
  expect(isOn()).toBe(false);
});

it("releases a latched mode when Shift is pressed again and released with no selection", async () => {
  await latchOver(appendParagraph());
  press("keydown", "Shift");
  window.getSelection()?.removeAllRanges();
  press("keyup", "Shift");
  expect(isOn()).toBe(false);
});

it("keeps a latched mode when Shift is pressed again and released over the selection", async () => {
  await latchOver(appendParagraph());
  press("keydown", "Shift");
  press("keyup", "Shift");
  expect(isOn()).toBe(true);
});

it("releases on window blur", () => {
  press("keydown", "Shift");
  window.dispatchEvent(new Event("blur"));
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

it("sees keys before a later window-capture listener that swallows them", () => {
  const swallow = (event: KeyboardEvent) => event.stopImmediatePropagation();
  window.addEventListener("keydown", swallow, true);
  press("keydown", "Shift");
  window.removeEventListener("keydown", swallow, true);
  expect(isOn()).toBe(true);
});

it("stops pointer events from reaching the page and blocks link clicks while held", () => {
  const link = document.createElement("a");
  link.href = "#navigated";
  link.textContent = "link";
  document.body.append(link);
  const reached: string[] = [];
  document.body.addEventListener("pointerdown", () => reached.push("pointerdown"));
  document.body.addEventListener("click", () => reached.push("click"));

  press("keydown", "Shift");
  const down = pointerdown(link);
  const clicked = click(link);

  expect(reached).toEqual([]);
  expect(down.defaultPrevented).toBe(false);
  expect(clicked.defaultPrevented).toBe(true);
});

it("lets pointer events through when off and for editable targets", () => {
  const input = document.createElement("input");
  document.body.append(input);
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));

  click(input);
  press("keydown", "Shift");
  click(input);

  expect(reached).toEqual(["click", "click"]);
});

it("prevents native drags while held but not inside an editable target", () => {
  const image = document.createElement("img");
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  editable.textContent = "editable text";
  document.body.append(image, editable);
  press("keydown", "Shift");

  const imageDrag = new Event("dragstart", { bubbles: true, cancelable: true });
  image.dispatchEvent(imageDrag);
  const textDrag = new Event("dragstart", { bubbles: true, cancelable: true });
  editable.firstChild?.dispatchEvent(textDrag);

  expect(imageDrag.defaultPrevented).toBe(true);
  expect(textDrag.defaultPrevented).toBe(false);
});

it("swallows the click that ends a held drag even when Shift was released first", () => {
  const target = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));
  press("keydown", "Shift");
  pointerdown(target);
  press("keyup", "Shift");

  const clicked = click(target);

  expect(reached).toEqual([]);
  expect(clicked.defaultPrevented).toBe(true);
  expect(click(target).defaultPrevented).toBe(false);
});

it("clears an earlier selection on a held pointerdown so the drag starts at the pointer", async () => {
  const earlier = appendParagraph("earlier text");
  const target = appendParagraph("target text");
  await selectContents(earlier);
  press("keydown", "Shift");

  pointerdown(target);

  expect(window.getSelection()?.rangeCount).toBe(0);
});

it("keeps the selection on a held right-button press", async () => {
  const target = appendParagraph();
  press("keydown", "Shift");
  await selectContents(target);
  pointerdown(target, { button: 2 });
  expect(window.getSelection()?.toString()).toBe("some text");
});

it("lets pointer events through once latched", async () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));
  await latchOver(paragraph);

  pointerdown(paragraph);
  const clicked = click(paragraph);

  expect(reached).toEqual(["click"]);
  expect(clicked.defaultPrevented).toBe(false);
});

it("blocks pointer events again when Shift is pressed a second time while latched", async () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("click", () => reached.push("click"));
  await latchOver(paragraph);
  press("keydown", "Shift");

  click(paragraph);

  expect(reached).toEqual([]);
});

it("stops the app's context menu over a selection without cancelling the native one", async () => {
  const paragraph = appendParagraph();
  const reached: string[] = [];
  document.body.addEventListener("contextmenu", () => reached.push("contextmenu"));
  await latchOver(paragraph);

  const contextmenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  paragraph.dispatchEvent(contextmenu);

  expect(reached).toEqual([]);
  expect(contextmenu.defaultPrevented).toBe(false);
});

it("leaves the context menu alone with no selection and in editable targets", async () => {
  const paragraph = appendParagraph();
  const input = document.createElement("input");
  document.body.append(input);
  const reached: string[] = [];
  document.body.addEventListener("contextmenu", () => reached.push("contextmenu"));

  press("keydown", "Shift");
  paragraph.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await selectContents(paragraph);
  input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

  expect(reached).toEqual(["contextmenu", "contextmenu"]);
});
