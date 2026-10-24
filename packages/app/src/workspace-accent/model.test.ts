import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR_NAMES, deriveIdentityColorName } from "@/styles/identity-colors";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import {
  WORKSPACE_ACCENT_FILL_STYLES,
  WORKSPACE_ACCENT_TINT_STYLES,
  findProjectViewKey,
  resolveWorkspaceAccent,
} from "./model";

describe("resolveWorkspaceAccent", () => {
  it("prefers the override over the project color", () => {
    const projectViewKey = "project-a";
    const override = IDENTITY_COLOR_NAMES.find(
      (name) => name !== deriveIdentityColorName(projectViewKey),
    )!;
    expect(resolveWorkspaceAccent({ override, projectViewKey })).toBe(override);
  });

  it("derives the project color exactly as the sidebar icon does", () => {
    expect(resolveWorkspaceAccent({ override: null, projectViewKey: "project-a" })).toBe(
      deriveIdentityColorName("project-a"),
    );
  });

  it("has no accent when neither source is known", () => {
    expect(resolveWorkspaceAccent({ override: null, projectViewKey: null })).toBeNull();
  });

  it("styles every identity color", () => {
    expect(Object.keys(WORKSPACE_ACCENT_TINT_STYLES).sort()).toEqual(
      [...IDENTITY_COLOR_NAMES].sort(),
    );
    expect(Object.keys(WORKSPACE_ACCENT_FILL_STYLES).sort()).toEqual(
      [...IDENTITY_COLOR_NAMES].sort(),
    );
  });
});

function project(id: string, key: string | null): ProjectDescriptor {
  return {
    projectId: id,
    projectKey: key,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: `/${id}`,
    projectKind: "git",
  };
}

function workspace(id: string, projectId: string): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: `/${projectId}`,
    workspaceDirectory: `/${projectId}`,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("findProjectViewKey", () => {
  const key = "remote:github.com/acme/app";
  const hostA = {
    serverId: "host-a",
    projects: [project("prj_a", key)],
    workspaces: [workspace("ws-a", "prj_a")],
  };
  const hostB = {
    serverId: "host-b",
    projects: [project("prj_b", key)],
    workspaces: [workspace("ws-b", "prj_b")],
  };

  it("gives a workspace the same color whether the structure spans one host or both", () => {
    const both = buildWorkspaceStructureProjects({ sessions: [hostA, hostB] });
    const aOnly = buildWorkspaceStructureProjects({ sessions: [hostA] });
    const fromBoth = findProjectViewKey(both, "host-a:ws-a");
    const fromA = findProjectViewKey(aOnly, "host-a:ws-a");
    expect(fromA).toBe(key);
    expect(fromBoth).toBe(fromA);
    expect(findProjectViewKey(both, "host-b:ws-b")).toBe(fromA);
  });

  it("is null for a workspace outside every project", () => {
    const projects = buildWorkspaceStructureProjects({ sessions: [hostA] });
    expect(findProjectViewKey(projects, "host-a:missing")).toBeNull();
  });
});
