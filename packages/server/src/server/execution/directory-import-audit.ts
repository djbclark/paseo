import * as ts from "typescript";

const sharedImports = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/server/ade-helpers",
  "zod",
] as const;

export type SelectedDirectoryArtifact = "claim" | "window";

function importNames(artifact: SelectedDirectoryArtifact): ReadonlySet<string> {
  if (artifact !== "claim" && artifact !== "window")
    throw new Error("Unknown selected directory artifact");
  return new Set([
    ...sharedImports,
    "node:fs",
    "node:path",
    ...(artifact === "claim" ? ["node:os", "node:crypto"] : []),
  ]);
}

function factoryExpression(file: ts.SourceFile): ts.FunctionExpression {
  if (file.statements.length !== 1 || !ts.isExpressionStatement(file.statements[0]))
    throw new Error("Selected directory factory required");
  let expression = file.statements[0].expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (
    !ts.isFunctionExpression(expression) ||
    expression.name ||
    expression.asteriskToken ||
    expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    expression.parameters.length !== 1 ||
    expression.parameters[0].initializer ||
    expression.parameters[0].dotDotDotToken ||
    !ts.isIdentifier(expression.parameters[0].name) ||
    expression.parameters[0].name.text !== "require"
  )
    throw new Error("Selected directory factory required");
  return expression;
}

function literalRequire(node: ts.CallExpression, names: ReadonlySet<string>): string {
  if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
    throw new Error("Dynamic selected directory require refused");
  const name = node.arguments[0].text;
  if (!names.has(name)) throw new Error("Unknown selected directory dependency");
  return name;
}

function assertRequireReference(node: ts.Identifier, factory: ts.FunctionExpression): void {
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.parent === factory && parent.name === node) return;
  if (ts.isCallExpression(parent) && parent.expression === node) return;
  throw new Error("Selected directory require alias or escape refused");
}

function assertNoNativeImport(node: ts.Node): void {
  if (
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
    (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
  )
    throw new Error("Native selected directory import refused");
}

/**
 * Denial-only compiled-code audit, BEFORE conversion/evaluation. Result DATA does
 * not qualify a realm, authorize helper work or supply an evaluated namespace.
 * The enrolled source/global/facade audit remains mandatory: this is not a sandbox.
 */
export function auditSelectedDirectoryImports(
  source: string,
  artifact: SelectedDirectoryArtifact,
): readonly string[] {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 16777216)
    throw new Error("Selected directory bundle exceeds bound");
  const syntax = ts.transpileModule(source, {
    fileName: "selected-directory.js",
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  if (syntax.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
    throw new Error("Invalid selected directory bundle syntax");
  const file = ts.createSourceFile(
    "selected-directory.js",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const factory = factoryExpression(file);
  const names = importNames(artifact);
  const imports = new Set<string>();
  function visit(node: ts.Node): void {
    assertNoNativeImport(node);
    if (ts.isIdentifier(node) && node.text === "require") assertRequireReference(node, factory);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      imports.add(literalRequire(node, names));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return Object.freeze([...imports].sort());
}
