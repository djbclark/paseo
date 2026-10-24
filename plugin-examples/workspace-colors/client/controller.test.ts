import type { PluginButton, PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi, type Mock } from "vitest";
import contribute from "../index.client";
import { startWorkspaceColors } from "./controller";

vi.mock("./swatches", () => ({ swatchFor: () => () => null }));
vi.mock("./settings-screen", () => ({ ColorSettingsScreen: () => null }));

interface Observer {
  snapshot(value: unknown): void;
  update(message: unknown): void;
}

function fakeClient(initial: unknown) {
  let stored = initial;
  let revision = 1;
  let failNextWrite = false;
  let workspaceObserver: Observer | undefined;
  let eventObserver: Observer | undefined;
  const accents: { workspaceId: string; update: Mock; remove: Mock }[] = [];
  const buttons = new Map<string, { update: Mock; remove: Mock }>();
  const writes: unknown[] = [];
  const release = vi.fn(async () => {});
  const client = {
    setWorkspaceAccent: vi.fn(({ workspaceId }: { workspaceId: string }) => {
      const registration = { workspaceId, update: vi.fn(), remove: vi.fn() };
      accents.push(registration);
      return registration;
    }),
    addHeaderButton: vi.fn(({ workspaceId }: { workspaceId: string; button: PluginButton }) => {
      const registration = { update: vi.fn(), remove: vi.fn() };
      buttons.set(workspaceId, registration);
      return registration;
    }),
    addSettingsScreen: vi.fn(() => vi.fn()),
    openSettings: vi.fn(),
    rpc: vi.fn(async (contract: { name: string }, input: { values: unknown }) => {
      if (contract.name === "settings.colors.read")
        return { status: "ready", revision: String(revision), values: stored };
      if (failNextWrite) {
        failNextWrite = false;
        revision += 1;
        return { status: "conflict", error: "stale" };
      }
      writes.push(input);
      stored = input.values;
      revision += 1;
      return { status: "saved", revision: String(revision), values: stored };
    }),
    paseo: {
      workspaces: {
        list: vi.fn(async () => ({
          subscription: {
            subscribe(observer: Observer) {
              workspaceObserver = observer;
              return () => {};
            },
            release,
          },
        })),
      },
      observeEvents: vi.fn(() => ({
        subscribe(observer: Observer) {
          eventObserver = observer;
          return () => {};
        },
        release,
      })),
    },
  };
  return {
    client: client as unknown as PluginClientContext,
    raw: client,
    accents,
    buttons,
    writes,
    release,
    failNextWrite: () => void (failNextWrite = true),
    setStored: (value: unknown) => void (stored = value),
    snapshot: (entries: unknown[]) => workspaceObserver?.snapshot({ entries }),
    removeWorkspace: (id: string) =>
      workspaceObserver?.update({ type: "workspace_update", payload: { kind: "remove", id } }),
    settingsChanged: (settingsId = "colors") =>
      eventObserver?.update({
        type: "status",
        payload: { status: "plugin_settings_changed", pluginId: "workspace-colors", settingsId },
      }),
    eventSnapshot: () => eventObserver?.snapshot({}),
  };
}

const settings = (patch: object) => ({ workspaces: {}, projects: {}, labelRules: [], ...patch });
const entries = [
  { id: "w1", projectId: "p1", labels: [] },
  { id: "w2", projectId: "p2", labels: ["Urgent"] },
  { id: "w3", projectId: "p3" },
];

async function started(initial: unknown) {
  const fake = fakeClient(initial);
  const stop = startWorkspaceColors(fake.client);
  await vi.waitFor(() => expect(fake.raw.paseo.workspaces.list).toHaveBeenCalled());
  await vi.waitFor(() => expect(fake.raw.paseo.observeEvents).toHaveBeenCalled());
  await Promise.resolve();
  fake.eventSnapshot();
  await vi.waitFor(() => expect(fake.raw.rpc).toHaveBeenCalled());
  fake.snapshot(entries);
  return { fake, stop };
}

describe("workspace colors", () => {
  it("returns a cleanup and does not throw on a client without setWorkspaceAccent", () => {
    const addSettingsScreen = vi.fn();
    const client = { addSettingsScreen } as unknown as PluginClientContext;
    let cleanup: () => void = () => {};
    expect(() => (cleanup = contribute(client))).not.toThrow();
    expect(() => cleanup()).not.toThrow();
    expect(addSettingsScreen).not.toHaveBeenCalled();
  });

  it("sets, updates and removes accents as workspaces and settings change", async () => {
    const { fake, stop } = await started(
      settings({ projects: { p1: "blue" }, labelRules: [{ label: "urgent", color: "red" }] }),
    );
    expect(fake.raw.setWorkspaceAccent.mock.calls.map(([call]) => call)).toEqual([
      { workspaceId: "w1", color: "blue" },
      { workspaceId: "w2", color: "red" },
    ]);
    expect(fake.raw.addHeaderButton).toHaveBeenCalledTimes(3);

    fake.setStored(settings({ projects: { p1: "teal" }, labelRules: [] }));
    fake.settingsChanged();
    await vi.waitFor(() => expect(fake.accents[0]?.update).toHaveBeenCalledWith({ color: "teal" }));
    expect(fake.accents[1]?.remove).toHaveBeenCalledTimes(1);

    fake.removeWorkspace("w1");
    expect(fake.accents[0]?.remove).toHaveBeenCalledTimes(1);
    expect(fake.buttons.get("w1")?.remove).toHaveBeenCalledTimes(1);

    stop();
    expect(fake.buttons.get("w3")?.remove).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledTimes(2);
  });

  it("ignores changes to other settings", async () => {
    const { fake } = await started(settings({}));
    const reads = fake.raw.rpc.mock.calls.length;
    fake.settingsChanged("other");
    await Promise.resolve();
    expect(fake.raw.rpc.mock.calls.length).toBe(reads);
  });

  it("writes a workspace color from the header menu and retries one conflict", async () => {
    const { fake } = await started(settings({}));
    const button = fake.raw.addHeaderButton.mock.calls[0]?.[0].button as PluginButton;
    if (button.behavior.kind !== "menu") throw new Error("expected a menu");
    const item = button.behavior.items.find(
      (entry) => entry.kind === "item" && entry.id === "workspace-teal",
    );
    if (item?.kind !== "item" || item.behavior.kind !== "action") throw new Error("missing item");
    fake.failNextWrite();
    await item.behavior.onPress();
    expect(fake.writes).toEqual([
      { revision: "2", values: settings({ workspaces: { w1: "teal" } }) },
    ]);
    expect(fake.raw.setWorkspaceAccent).toHaveBeenCalledWith({ workspaceId: "w1", color: "teal" });
  });
});
