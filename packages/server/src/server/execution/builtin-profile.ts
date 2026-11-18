import builtinPlugins from "./builtin-inventory.json" with { type: "json" };
export interface QualifiedBuiltinProfile {
  id: string;
  sourceSha256: string;
  serverBundleSha256: string;
  moduleTableSha256: string;
  activityContract: "builtin-in-process-v1";
  profileSha256: string;
}
/** Missing/invalid external profile never prevents ordinary builtin registration. */
export function readBuiltinProfiles(value: unknown): QualifiedBuiltinProfile[] | null {
  if (!Array.isArray(value) || value.length > builtinPlugins.length) return null;
  const ids = new Set<string>();
  const result: QualifiedBuiltinProfile[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    if (
      JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify([
        "activityContract",
        "id",
        "moduleTableSha256",
        "profileSha256",
        "serverBundleSha256",
        "sourceSha256",
      ])
    )
      return null;
    if (
      !builtinPlugins.includes(row.id) ||
      ids.has(row.id) ||
      row.activityContract !== "builtin-in-process-v1"
    )
      return null;
    for (const key of ["moduleTableSha256", "profileSha256", "serverBundleSha256", "sourceSha256"])
      if (typeof row[key] !== "string" || !/^[a-f0-9]{64}$/.test(row[key])) return null;
    ids.add(row.id);
    result.push({ ...row });
  }
  return result;
}
