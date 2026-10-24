import { describe, expect, it } from "vitest";
import type { ColorSettings } from "./colors";
import { resolveWorkspaceColor } from "./resolve";

const settings = (patch: Partial<ColorSettings>): ColorSettings => ({
  workspaces: {},
  projects: {},
  labelRules: [],
  ...patch,
});
const workspace = { id: "w1", projectId: "p1", labels: ["Frontend Team", "urgent"] };

describe("resolveWorkspaceColor", () => {
  it("returns null when nothing matches", () => {
    expect(resolveWorkspaceColor(workspace, settings({}))).toBeNull();
  });

  it("prefers a workspace override over a label rule and a project color", () => {
    const result = resolveWorkspaceColor(
      workspace,
      settings({
        workspaces: { w1: "red" },
        projects: { p1: "blue" },
        labelRules: [{ label: "urgent", color: "amber" }],
      }),
    );
    expect(result).toBe("red");
  });

  it("prefers a label rule over a project color", () => {
    const result = resolveWorkspaceColor(
      workspace,
      settings({ projects: { p1: "blue" }, labelRules: [{ label: "urgent", color: "amber" }] }),
    );
    expect(result).toBe("amber");
  });

  it("falls back to the project color", () => {
    expect(resolveWorkspaceColor(workspace, settings({ projects: { p1: "blue" } }))).toBe("blue");
  });

  it("matches labels ignoring case and extra whitespace", () => {
    const result = resolveWorkspaceColor(
      workspace,
      settings({ labelRules: [{ label: "  frontend   TEAM ", color: "teal" }] }),
    );
    expect(result).toBe("teal");
  });

  it("uses the first matching rule", () => {
    const result = resolveWorkspaceColor(
      workspace,
      settings({
        labelRules: [
          { label: "urgent", color: "pink" },
          { label: "frontend team", color: "sky" },
        ],
      }),
    );
    expect(result).toBe("pink");
  });

  it("skips label rules when the workspace has no labels", () => {
    const result = resolveWorkspaceColor(
      { id: "w1", projectId: "p1" },
      settings({ projects: { p1: "violet" }, labelRules: [{ label: "urgent", color: "red" }] }),
    );
    expect(result).toBe("violet");
  });
});
