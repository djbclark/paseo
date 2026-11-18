import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import builtinPlugins from "../src/server/execution/builtin-inventory.json" with { type: "json" };

// Finite source list and all resources, not an empty-loader replacement. Unknown
// additions require a reviewed inventory change before a new build can proceed.
export async function retainBuiltinPlugins(repositoryRoot, outDir) {
  const loader = path.join(repositoryRoot, "packages/server/src/server/plugins/builtin/index.ts");
  const source = ts.createSourceFile(
    loader,
    await readFile(loader, "utf8"),
    ts.ScriptTarget.Latest,
  );
  let actual;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "builtinPlugins")
        continue;
      const initializer = declaration.initializer;
      const array =
        initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer;
      if (
        !array ||
        !ts.isArrayLiteralExpression(array) ||
        !array.elements.every(ts.isStringLiteral)
      )
        throw new Error("Unknown builtin loader declaration");
      actual = array.elements.map((item) => item.text);
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(builtinPlugins))
    throw new Error("Builtin source inventory changed");
  const sourceInputs = [];
  async function copyRegular(relative, destination) {
    const file = path.join(repositoryRoot, relative);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 16 * 1024 * 1024)
        throw new Error("Invalid builtin source member");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.size !== bytes.length ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Unstable builtin source member");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      sourceInputs.push({
        path: relative.split(path.sep).join("/"),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  async function copyTree(relative, destination) {
    const stat = await lstat(path.join(repositoryRoot, relative));
    if (!stat.isDirectory()) throw new Error("Invalid builtin source directory");
    for (const name of (await readdir(path.join(repositoryRoot, relative))).sort()) {
      const child = path.join(relative, name);
      const info = await lstat(path.join(repositoryRoot, child));
      if (info.isSymbolicLink()) throw new Error("Builtin source symlink unsupported");
      if (info.isDirectory()) await copyTree(child, path.join(destination, name));
      else await copyRegular(child, path.join(destination, name));
    }
  }
  for (const id of builtinPlugins)
    await copyTree(`plugins/${id}`, path.join(outDir, "builtin-plugins", id));
  for (const name of ["package.json", "tsconfig.json"])
    await copyRegular(`plugins/${name}`, path.join(outDir, "builtin-plugins", name));
  await copyRegular("tsconfig.base.json", path.join(outDir, "tsconfig.base.json"));
  return { ids: builtinPlugins, sourceInputs };
}
