import { fileURLToPath } from "node:url";
import path from "node:path";

export const BUILD_ARCHIVE_LIMITS = Object.freeze({
  tarBytes: 536870912,
  zipBytes: 134217728,
  members: 10000,
});

/** Build evidence bounds only; no execution or qualification authority. */
export function assertQualifiedTarBudget(bytes, listing) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > BUILD_ARCHIVE_LIMITS.tarBytes)
    throw new Error("Build TAR size exceeds accepted bound");
  // GNU tar --list --quoting-style=escape produces one escaped logical member per line.
  // Count directories too; PAX extension records are metadata, not additional members.
  if (typeof listing !== "string" || !listing.endsWith("\n"))
    throw new Error("Invalid build TAR member listing");
  const rows = listing.slice(0, -1).split("\n");
  if (rows.some((row) => row.length === 0) || rows.length > BUILD_ARCHIVE_LIMITS.members)
    throw new Error("Build TAR members exceed accepted bound");
  return Object.freeze({ bytes, members: rows.length });
}

export function assertQualifiedBuildArtifact(metadata, expected) {
  const { artifactId, runId, attempt, head } = expected;
  if (
    !/^[1-9][0-9]*$/.test(artifactId) ||
    !/^[1-9][0-9]*$/.test(runId) ||
    !/^[1-9][0-9]*$/.test(attempt) ||
    !/^[0-9a-f]{40}$/.test(head)
  )
    throw new Error("Invalid build artifact expectation");
  const expectedName = `qualified-daemon-build-${head}-${runId}-${attempt}`;
  if (
    !metadata ||
    String(metadata.id) !== artifactId ||
    metadata.name !== expectedName ||
    metadata.expired !== false ||
    String(metadata.workflow_run?.id) !== runId ||
    metadata.workflow_run?.head_sha !== head ||
    metadata.workflow_run?.repository_id !== 1432178170 ||
    metadata.workflow_run?.head_repository_id !== 1432178170 ||
    !Number.isSafeInteger(metadata.size_in_bytes) ||
    metadata.size_in_bytes <= 0 ||
    metadata.size_in_bytes > BUILD_ARCHIVE_LIMITS.zipBytes
  )
    throw new Error("Uploaded build artifact identity or ZIP size refused");
  return Object.freeze({
    artifactId,
    zipBytes: metadata.size_in_bytes,
    qualification: false,
  });
}

async function readMetadata(response) {
  if (!response.ok || !response.body) throw new Error("Build artifact metadata unavailable");
  let bytes = 0;
  const blocks = [];
  for await (const block of response.body) {
    bytes += block.byteLength;
    if (bytes > 65536) throw new Error("Build artifact metadata exceeds bound");
    blocks.push(Buffer.from(block));
  }
  return JSON.parse(Buffer.concat(blocks).toString("utf8"));
}

async function main() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.platform !== "linux" ||
    process.env.GITHUB_REPOSITORY !== "djbclark/paseo" ||
    !process.env.GITHUB_TOKEN ||
    process.argv.length !== 3
  )
    throw new Error("Build artifact acceptance is fixed Linux fork CI only");
  const expected = {
    artifactId: process.argv[2],
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    head: process.env.GITHUB_SHA,
  };
  if (!/^[1-9][0-9]*$/.test(expected.artifactId)) throw new Error("Invalid uploaded artifact ID");
  const response = await fetch(
    `https://api.github.com/repos/djbclark/paseo/actions/artifacts/${expected.artifactId}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  const result = assertQualifiedBuildArtifact(await readMetadata(response), expected);
  // This measures the actual service-produced ZIP AFTER upload. An oversized paid
  // artifact is preserved as failed evidence; downstream still authenticates bytes.
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
