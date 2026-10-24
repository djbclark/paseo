import { defineSettings } from "@getpaseo/plugin";
import type { PluginIdentityColor } from "@getpaseo/plugin/client";
import { z } from "zod";

// Kept as a runtime list here so an app without the SDK's color table never sees a missing value.
export const COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const satisfies readonly PluginIdentityColor[];

const Color = z.enum(COLORS);

export const colorSettings = defineSettings({
  id: "colors",
  scope: "host",
  version: 1,
  schema: z.object({
    workspaces: z.record(z.string(), Color).default({}),
    projects: z.record(z.string(), Color).default({}),
    labelRules: z
      .array(z.object({ label: z.string().trim().min(1).max(64), color: Color }))
      .max(32)
      .default([]),
  }),
});

export type ColorSettings = z.output<typeof colorSettings.schema>;
