import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useStatusRingAnimationRef } from "@/components/status-ring/clock.web";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

const preference = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("react-native-reanimated", () => ({
  useReducedMotion: () => preference.reducedMotion,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  preference.reducedMotion = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Ring({ id }: { id: string }) {
  const animationRef = useStatusRingAnimationRef();
  return <View ref={animationRef} testID={id} />;
}

function renderRings(active: boolean) {
  act(() => {
    root.render(
      <RetainedPanelActivity active={active}>
        <Ring id="first-ring" />
        <Ring id="second-ring" />
      </RetainedPanelActivity>,
    );
  });
}

function ring(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ring ${id}`);
  return element;
}

function animation(id: string): Animation {
  const animations = ring(id).getAnimations();
  expect(animations).toHaveLength(1);
  return animations[0];
}

it("starts visible rings at the same epoch with the original rotation timing", () => {
  renderRings(true);

  const first = animation("first-ring");
  const second = animation("second-ring");
  expect(first).not.toBe(second);
  expect(first.startTime).toBe(0);
  expect(second.startTime).toBe(first.startTime);
  expect(first.effect?.getTiming()).toMatchObject({
    duration: STATUS_RING_PERIOD_MS,
    iterations: Infinity,
    easing: "linear",
  });
});

it("does not animate a retained panel that starts inactive", () => {
  renderRings(false);

  expect(ring("first-ring").getAnimations()).toHaveLength(0);
  expect(ring("second-ring").getAnimations()).toHaveLength(0);
});

it("does not animate when reduced motion was requested at launch", () => {
  preference.reducedMotion = true;
  renderRings(true);

  expect(ring("first-ring").getAnimations()).toHaveLength(0);
  expect(ring("second-ring").getAnimations()).toHaveLength(0);
});

it("cancels the original animations on deactivation and synchronizes reactivation", () => {
  renderRings(true);
  const firstElement = ring("first-ring");
  const first = animation("first-ring");
  const second = animation("second-ring");

  renderRings(false);
  expect(ring("first-ring")).toBe(firstElement);
  expect(first.playState).toBe("idle");
  expect(second.playState).toBe("idle");
  expect(firstElement.getAnimations()).toHaveLength(0);
  expect(ring("second-ring").getAnimations()).toHaveLength(0);

  renderRings(true);
  const resumedFirst = animation("first-ring");
  const resumedSecond = animation("second-ring");
  expect(resumedFirst).not.toBe(first);
  expect(resumedSecond).not.toBe(second);
  expect(resumedFirst.startTime).toBe(0);
  expect(resumedSecond.startTime).toBe(resumedFirst.startTime);
  expect(first.playState).toBe("idle");
  expect(second.playState).toBe("idle");
});

it("cancels both original animations when the mounted rings are removed", () => {
  renderRings(true);
  const first = animation("first-ring");
  const second = animation("second-ring");

  act(() => root.render(null));

  expect(first.playState).toBe("idle");
  expect(second.playState).toBe("idle");
  expect(container.childElementCount).toBe(0);
});
