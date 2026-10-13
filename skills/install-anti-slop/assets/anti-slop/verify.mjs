#!/usr/bin/env node
// Verifies this copy of the anti-slop plugin against the MANIFEST.sha256 beside
// it, offline, with nothing but Node.
//
//   node verify.mjs              the whole plugin, tests included
//   node verify.mjs --no-tests   a copy installed with `install.mjs --no-tests`
//
// Exit 0: every shipped file is present and unchanged and nothing else is here.
// Exit 1: one sentence per problem on stderr (a missing, modified or extra file,
// or a manifest that cannot be read). Exit 2: an argument it does not know.
//
// MANIFEST.sha256 holds one `<sha256-hex>  <path>` line per shipped file, paths
// relative to this directory with `/` separators, sorted bytewise, LF endings,
// and no line for itself. `sha256sum -c MANIFEST.sha256` reads it too. It catches
// drift, not tampering: whoever can edit a rule can edit the manifest, so pin
// the manifest's own digest wherever your repository pins other inputs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_NAME = "MANIFEST.sha256";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORIES = new Set([
  "__fixtures__",
  "__snapshots__",
  "__tests__",
  "fixtures",
]);
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/u;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/u;

/**
 * Test-only paths: `*.test.*` and `*.spec.*` files, and anything under a
 * `fixtures`, `__fixtures__`, `__snapshots__` or `__tests__` directory. The
 * installer leaves exactly these out under `--no-tests`, and this script does
 * not expect them there, so the two cannot disagree.
 */
export function isTestOnly(path) {
  const parts = path.split("/");
  return (
    TEST_FILE.test(parts[parts.length - 1]) ||
    parts.some((part) => TEST_DIRECTORIES.has(part))
  );
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Shipped files under `root` as sorted posix paths; `problems` collects what is not a plain file. */
export function listFiles(root, problems = [], prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = `${prefix}${entry.name}`;
    if (path === MANIFEST_NAME) continue;
    if (entry.isDirectory())
      found.push(...listFiles(root, problems, `${path}/`));
    else if (entry.isFile()) found.push(path);
    else
      problems.push(
        `Not a regular file: ${path} is a ${entry.isSymbolicLink() ? "symbolic link" : "special file"}, and the plugin is vendored as plain files.`,
      );
  }
  return found.sort(byPath);
}

function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The manifest text for the files under `root`. Refuses a path the format cannot carry. */
export function renderManifest(root) {
  const problems = [];
  const files = listFiles(root, problems);
  for (const path of files)
    if (!SAFE_PATH.test(path))
      problems.push(
        `Unsupported path: ${JSON.stringify(path)} has a character outside A-Z a-z 0-9 . _ - /.`,
      );
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return files.map((path) => `${sha256(join(root, path))}  ${path}\n`).join("");
}

/** Digests by path, plus a sentence for every line the manifest gets wrong. */
export function parseManifest(text) {
  const digests = new Map();
  const problems = [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, index) => {
    const where = `${MANIFEST_NAME} line ${index + 1}`;
    const match = MANIFEST_LINE.exec(line);
    if (match === null) {
      problems.push(`${where} is not "<sha256>  <path>".`);
      return;
    }
    const [, digest, path] = match;
    if (path === MANIFEST_NAME) problems.push(`${where} lists itself.`);
    else if (!SAFE_PATH.test(path) || path.split("/").some(isEscape))
      problems.push(
        `${where} names ${path}, which is not a path inside the plugin directory.`,
      );
    else if (digests.has(path))
      problems.push(`${where} lists ${path} a second time.`);
    else digests.set(path, digest);
  });
  return { digests, problems };
}

function isEscape(part) {
  return part === "" || part === "." || part === "..";
}

/**
 * Check `root` against its manifest. With `noTests`, the manifest's test-only
 * entries are not expected, and a test-only file on disk is extra.
 * @returns {{ problems: string[], checked: number, skipped: number, missingTests: number }}
 */
export function verifyTree(root, { noTests = false } = {}) {
  let text;
  try {
    text = readFileSync(join(root, MANIFEST_NAME), "utf8");
  } catch {
    return {
      problems: [`${MANIFEST_NAME} is missing, so nothing can be verified.`],
      checked: 0,
      skipped: 0,
      missingTests: 0,
    };
  }
  const { digests, problems } = parseManifest(text);
  let skipped = 0;
  let missingTests = 0;
  const expected = new Map();
  for (const [path, digest] of digests) {
    if (noTests && isTestOnly(path)) skipped += 1;
    else expected.set(path, digest);
  }
  const present = new Set(listFiles(root, problems));
  for (const [path, digest] of expected) {
    if (!present.has(path)) {
      if (isTestOnly(path)) missingTests += 1;
      problems.push(
        `Missing file: ${path} is listed in ${MANIFEST_NAME} but is not installed.`,
      );
    } else if (sha256(join(root, path)) !== digest) {
      problems.push(
        `Modified file: ${path} does not match the digest in ${MANIFEST_NAME}.`,
      );
    }
  }
  for (const path of present) {
    if (expected.has(path)) continue;
    problems.push(
      noTests && isTestOnly(path)
        ? `Extra file: ${path} is a test file, which an install with --no-tests does not contain.`
        : `Extra file: ${path} is installed but is not listed in ${MANIFEST_NAME}.`,
    );
  }
  return {
    problems: order(problems),
    checked: expected.size,
    skipped,
    missingTests,
  };
}

/** Missing, then modified, then extra: the order a reader repairs them in. */
function order(problems) {
  const rank = (sentence) =>
    ["Missing", "Modified", "Extra"].findIndex((word) => sentence.startsWith(word));
  return problems
    .map((sentence, index) => ({ sentence, index }))
    .sort((a, b) => rank(a.sentence) - rank(b.sentence) || a.index - b.index)
    .map(({ sentence }) => sentence);
}

function main(argv) {
  const rest = argv.filter((argument) => argument !== "--no-tests");
  if (rest.length > 0) {
    console.error("Usage: node verify.mjs [--no-tests]");
    return 2;
  }
  const noTests = rest.length !== argv.length;
  const { problems, checked, skipped, missingTests } = verifyTree(
    dirname(fileURLToPath(import.meta.url)),
    { noTests },
  );
  if (problems.length > 0) {
    for (const sentence of problems) console.error(sentence);
    if (!noTests && missingTests > 0)
      console.error(
        `Hint: ${missingTests} of the missing files are test files; if the plugin was installed with --no-tests, run: node verify.mjs --no-tests`,
      );
    return 1;
  }
  const note = noTests
    ? ` (${skipped} test files not expected under --no-tests)`
    : "";
  console.log(`anti-slop: ${checked} files match ${MANIFEST_NAME}${note}.`);
  return 0;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
