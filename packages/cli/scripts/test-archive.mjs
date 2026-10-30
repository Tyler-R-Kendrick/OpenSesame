/** Validate the actual archive using ordinary JS and strict TypeScript resolution. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";

const archive = process.argv[2];
if (!archive) throw new Error("An actual CLI release archive is required.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(join(tmpdir(), "opensesame-archive-control-"));
try {
  await writeFile(
    join(stage, "package.json"),
    '{"type":"module","private":true}\n',
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(archive),
    ],
    { cwd: stage, stdio: "inherit" },
  );
  const names = [
    "GlobalFlagsSchema",
    "SessionFileSchema",
    "helpText",
    "parseArgs",
    "runCli",
  ];
  const actual = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import * as cli from "@opensesame/cli"; console.log(JSON.stringify(Object.keys(cli).sort()))',
      ],
      {
        cwd: stage,
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      },
    ),
  );
  assert.deepEqual(actual, names);
  const consumer = join(stage, "consumer.mts");
  await writeFile(
    consumer,
    'import { runCli, parseArgs, helpText, SessionFileSchema, GlobalFlagsSchema } from "@opensesame/cli";\nimport type { ParsedCommand, GlobalFlags, SessionFile } from "@opensesame/cli";\nvoid [runCli, parseArgs, helpText, SessionFileSchema, GlobalFlagsSchema];\nexport type Consumer = [ParsedCommand, GlobalFlags, SessionFile];\n',
  );
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    strict: true,
    skipLibCheck: false,
    noEmit: true,
  };
  const program = ts.createProgram([consumer], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => stage,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(consumer);
  const module = checker.getSymbolAtLocation(
    source.statements[0].moduleSpecifier,
  );
  const declaredValues = checker
    .getExportsOfModule(module)
    .filter((symbol) => {
      const resolved =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      return Boolean(resolved.flags & ts.SymbolFlags.Value);
    })
    .map((symbol) => symbol.name)
    .sort();
  assert.deepEqual(declaredValues, actual);
  const packageRoot = join(stage, "node_modules/@opensesame/cli");
  const originalHarness = await readFile(
    join(root, "scripts/test-native-installed.mjs"),
    "utf8",
  );
  const originalRoot =
    'const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");';
  const originalEntry = 'pathToFileURL(join(stage, "dist/index.js")).href';
  assert.equal(
    originalHarness.split(originalRoot).length,
    2,
    "Harness root substitution must match exactly once.",
  );
  assert.equal(
    originalHarness.split(originalEntry).length,
    2,
    "Harness entry substitution must match exactly once.",
  );
  const harness = originalHarness
    .replace(originalRoot, `const root = ${JSON.stringify(packageRoot)};`)
    .replace(originalEntry, '"@opensesame/cli"');
  assert.ok(!harness.includes(originalRoot));
  assert.ok(!harness.includes(originalEntry));
  const driver = join(stage, "native-control.mjs");
  await writeFile(driver, harness);
  execFileSync(process.execPath, [driver], {
    cwd: stage,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      OPENSESAME_NATIVE_TEST_BINARY: join(
        packageRoot,
        "dist/native",
        `${process.platform}-${process.arch}`,
        process.platform === "win32" ? "opensesame.exe" : "opensesame",
      ),
    },
  });
  console.log(
    "Offline archive: bare JS import, exact value exports, strict NodeNext types, and release native public commands passed.",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
