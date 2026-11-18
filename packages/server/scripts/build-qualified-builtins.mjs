import { build } from "esbuild";
import { canonicalBuiltinJson } from "../dist/server/server/execution/builtin-format.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import builtinPlugins from "../src/server/execution/builtin-inventory.json" with { type: "json" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const wrap = (code) =>
  `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
function finiteImports(source) {
  const parsed = ts.createSourceFile(
    "builtin.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const transformed = ts.transform(parsed, [
    (context) => {
      const visit = (node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          return context.factory.updateCallExpression(
            node,
            context.factory.createIdentifier("__qualifiedBuiltinImport"),
            undefined,
            node.arguments,
          );
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  try {
    const file = transformed.transformed[0];
    if (file.statements.length !== 1 || !ts.isExpressionStatement(file.statements[0]))
      throw new Error("Unknown builtin factory expression");
    return ts
      .createPrinter()
      .printNode(ts.EmitHint.Expression, file.statements[0].expression, file);
  } finally {
    transformed.dispose();
  }
}
// Build-only producer: actual compiler output is checked against the independently
// retained esbuild metafile before lexical builtin-global/import adaptation.
export async function precompileBuiltinPlugins(
  repositoryRoot,
  outDir,
  sourceInputs,
  normalizeMetafile,
) {
  const compiled = path.join(repositoryRoot, "packages/server/dist/server/server/plugins");
  const { compileDirectoryPlugin } = await import(
    pathToFileURL(path.join(compiled, "compiler-build.js")).href
  );
  const { SERVER_HOST_MODULES } = await import(
    pathToFileURL(path.join(compiled, "compiler-esbuild.js")).href
  );
  const version = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/server/package.json"), "utf8"),
  ).version;
  const artifacts = [];
  const additionalInputs = new Map();
  for (const id of builtinPlugins) {
    const directory = path.join(repositoryRoot, "plugins", id);
    const actual = await compileDirectoryPlugin(directory, version, id);
    if (!actual.serverBundle || actual.clientBundle !== null)
      throw new Error("Unknown finite builtin target layout");
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [path.join(directory, "index.server.ts")],
      bundle: true,
      format: "cjs",
      jsx: "automatic",
      loader: { ".svg": "text" },
      platform: "node",
      target: "node20",
      external: SERVER_HOST_MODULES,
      metafile: true,
      logLevel: "silent",
      treeShaking: true,
      write: false,
    });
    const original = result.outputFiles[0]?.text;
    if (!original || wrap(original) !== actual.serverBundle)
      throw new Error(`Builtin compiler/metafile byte mismatch: ${id}`);
    const prefix = `builtin-compiled/${id}`;
    const normalized = normalizeMetafile(result.metafile, `${prefix}/server-original.js`);
    const imports = [
      ...new Set(
        Object.values(result.metafile.outputs).flatMap((row) =>
          row.imports.filter((item) => item.external).map((item) => item.path),
        ),
      ),
    ].sort();
    for (const name of Object.keys(normalized.inputs)) {
      const bytes = await readFile(path.join(repositoryRoot, name));
      additionalInputs.set(name, { path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    const sourceRowsByPath = new Map(
      sourceInputs
        .filter((row) => row.path.startsWith(`plugins/${id}/`))
        .map((row) => [row.path, row]),
    );
    for (const name of Object.keys(normalized.inputs))
      sourceRowsByPath.set(name, additionalInputs.get(name));
    for (const name of [
      "plugins/package.json",
      "plugins/tsconfig.json",
      "tsconfig.base.json",
      "package-lock.json",
      "packages/server/src/server/plugins/compiler-build.ts",
      "packages/server/scripts/build-qualified-builtins.mjs",
    ]) {
      const bytes = await readFile(path.join(repositoryRoot, name));
      sourceRowsByPath.set(name, { path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    const sourceRows = [...sourceRowsByPath.values()].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
    );
    const sourceIdentity = canonicalBuiltinJson({
      schemaVersion: 1,
      contract: "builtin-source-input-v1",
      files: sourceRows,
      resolution: normalized,
    });
    const factory = `(function(require, globals) {\nconst process=globals.process; const fetch=globals.fetch; const setTimeout=globals.setTimeout; const setInterval=globals.setInterval; const clearTimeout=globals.clearTimeout; const clearInterval=globals.clearInterval; const __qualifiedBuiltinImport=globals.import;\nreturn (${finiteImports(actual.serverBundle)})(require);\n})`;
    const files = {
      "server-original.js": actual.serverBundle,
      "server.factory.js": factory,
      "manifest.json": JSON.stringify(actual.manifest),
      "metafile.json": JSON.stringify(normalized),
      "source-identity.json": sourceIdentity,
    };
    await mkdir(path.join(outDir, prefix), { recursive: true });
    for (const [name, bytes] of Object.entries(files))
      await writeFile(path.join(outDir, prefix, name), bytes);
    artifacts.push({
      id,
      sourceSha256: digest(sourceIdentity),
      sourceIdentityPath: `${prefix}/source-identity.json`,
      serverBundleSha256: digest(factory),
      originalServerBundleSha256: digest(actual.serverBundle),
      factoryPath: `${prefix}/server.factory.js`,
      manifestPath: `${prefix}/manifest.json`,
      metafilePath: `${prefix}/metafile.json`,
      moduleImports: imports,
    });
  }
  return { artifacts, sourceInputs: [...additionalInputs.values()] };
}
