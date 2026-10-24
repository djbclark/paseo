import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceAccent } from "@/workspace-accent/model";

export interface WorkspaceTabDescriptor {
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
  /** The tab's own color, from `workspace-accent/tab-accent-state`; not part of the layout. */
  accent?: WorkspaceAccent;
  state?: import("@getpaseo/protocol/agent-types").JsonValue;
}
