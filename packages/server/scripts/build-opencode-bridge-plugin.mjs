import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

for (const directory of ["", "v2/"]) {
  const sourcePath = fileURLToPath(
    new URL(
      `../src/server/agent/providers/opencode/${directory}bridge-plugin.mjs`,
      import.meta.url,
    ),
  );
  const outputPath = fileURLToPath(
    new URL(
      `../dist/server/server/agent/providers/opencode/${directory}bridge-plugin.bundle.mjs`,
      import.meta.url,
    ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    outfile: outputPath,
    metafile: true,
  });
  // Packaging consumes the original emitted bytes, not a second bridge build.
  const artifact = await readFile(outputPath);
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  await writeFile(
    `${outputPath}.meta.json`,
    JSON.stringify({
      schemaVersion: 1,
      workingDirectory: path.relative(repository, process.cwd()),
      artifact: {
        size: artifact.length,
        sha256: createHash("sha256").update(artifact).digest("hex"),
      },
      metafile: result.metafile,
    }),
  );
  if (directory === "v2/") {
    await copyFile(
      new URL("../src/server/agent/providers/opencode/v2/state.mjs", import.meta.url),
      path.join(path.dirname(outputPath), "state.mjs"),
    );
  }
}
