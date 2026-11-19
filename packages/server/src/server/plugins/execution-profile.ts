import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PassivePluginProfileSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("native-passive-contract-1"),
    qualificationSha256: Digest,
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    initialization: z.literal("registration-only"),
  })
  .strict();
export type PassivePluginProfile = z.infer<typeof PassivePluginProfileSchema>;
export const DirectoryHelperPluginProfileSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("ade-directory-helpers-v1"),
    qualificationSha256: Digest,
    runtimeClosureSha256: Digest,
    helperClosureSha256: Digest,
    moduleTableSha256: Digest,
    recipeSha256: Digest,
    initialization: z.literal("registration-only"),
  })
  .strict();
export type DirectoryHelperPluginProfile = z.infer<typeof DirectoryHelperPluginProfileSchema>;
export type ManagedPluginExecutionProfile = PassivePluginProfile | DirectoryHelperPluginProfile;
