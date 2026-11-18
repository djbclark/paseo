import type { PluginProcessRequest } from "./plugin-process-protocol.js";
export type PluginExecutionRoot = Extract<
  PluginProcessRequest,
  {
    type:
      | "invoke"
      | "hook"
      | "tool.call"
      | "provider.status"
      | "provider.catalog_key"
      | "provider.connect"
      | "provider.send"
      | "usage.fetch"
      | "usage.discover"
      | "subscribe";
  }
>;
export function isPluginExecutionRoot(
  message: PluginProcessRequest,
): message is PluginExecutionRoot {
  switch (message.type) {
    case "invoke":
    case "hook":
    case "tool.call":
    case "provider.status":
    case "provider.catalog_key":
    case "provider.connect":
    case "provider.send":
    case "usage.fetch":
    case "usage.discover":
    case "subscribe":
      return true;
    default:
      return false;
  }
}
export function pluginExecutionKey(message: PluginExecutionRoot): string {
  if (message.type === "provider.connect") return `connect:${message.connectionId}`;
  if (message.type === "provider.send")
    return `send:${message.connectionId}:${message.acceptanceId}`;
  return message.requestId;
}
