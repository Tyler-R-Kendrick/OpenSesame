#!/usr/bin/env node
/**
 * Fail when a tracked source, doc, or spec file commits a Tailscale key literal
 * (`tskey-api-`, `tskey-client-`, or `tskey-auth-` followed by key material).
 *
 * Prefix checks, ellipsis placeholders (`tskey-api-…`), regex-only lines, the
 * production TOKEN pattern, Handlebars templates, and the synthetic minters
 * are not key material.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_SEGMENTS = new Set(["node_modules", "target", "dist", ".git"]);
const SKIP_BASENAMES = new Set(["pnpm-lock.yaml", "Cargo.lock"]);
const SKIP_SUFFIXES = [
  "packages/app-core/src/lib/synthetic-tailscale-key.ts",
  "packages/app-core/src/lib/synthetic-tailscale-key.test.ts",
  "scripts/security/tskey-literal-gate.mjs",
];
const SOURCE_EXT =
  /\.(?:[cm]?[jt]sx?|mjs|cjs|rs|py|go|kts?|swift|java|sh|bash|md|mdx|txt|json|ya?ml|toml|html|css|sql|proto|wit|rhai)$/u;

/** A committed key: the kind prefix plus at least one secret character. */
const LITERAL_SOURCE = "tskey-(?:api|client|auth)-[A-Za-z0-9]";
const TOKEN_LINE =
  /export const TOKEN\s*=\s*\/\^tskey-\[A-Za-z0-9_-\]\{8,300\}\$/u;

function hasLiteral(line) {
  return new RegExp(LITERAL_SOURCE).test(line);
}

function literalMatches(line) {
  return [...line.matchAll(new RegExp(LITERAL_SOURCE, "g"))];
}

function gitRoot(start) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start,
    encoding: "utf8",
  }).trim();
}

function listedFiles(root) {
  const args = [
    ["ls-files", "-z"],
    ["ls-files", "-z", "--others", "--exclude-standard"],
  ];
  const found = new Set();
  for (const gitArgs of args) {
    const out = execFileSync("git", gitArgs, {
      cwd: root,
      encoding: "utf8",
    });
    for (const path of out.split("\0")) {
      if (path) found.add(path);
    }
  }
  return [...found];
}

/** True when this repo-relative path is source, docs, or spec we should read. */
export function isScannablePath(relPath) {
  const path = relPath.replaceAll("\\", "/");
  if (!path || path.endsWith(".hbs")) return false;
  const parts = path.split("/");
  if (parts.some((part) => SKIP_SEGMENTS.has(part))) return false;
  if (SKIP_BASENAMES.has(parts.at(-1) ?? "")) return false;
  if (SKIP_SUFFIXES.some((suffix) => path === suffix || path.endsWith(`/${suffix}`)))
    return false;
  if (path.startsWith("docs/") || path.startsWith("spec/")) return true;
  return SOURCE_EXT.test(path);
}

function regexSpans(line) {
  const spans = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "/") continue;
    const previous = index > 0 ? line[index - 1] : "";
    if (previous && /[\w)]/u.test(previous)) continue;
    let cursor = index + 1;
    let closed = false;
    while (cursor < line.length) {
      if (line[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (line[cursor] === "/") {
        closed = true;
        break;
      }
      cursor += 1;
    }
    if (!closed) continue;
    spans.push([index, cursor]);
    index = cursor;
  }
  return spans;
}

function insideSpan(index, spans) {
  return spans.some(([start, end]) => index >= start && index <= end);
}

function isTokenRegexLine(relPath, line) {
  return (
    relPath.endsWith("packages/app-core/src/lib/native-tailscale-api.ts") &&
    TOKEN_LINE.test(line)
  );
}

/** Docs and UI copy that show the shape with an ellipsis, not a key. */
function isEllipsisPlaceholderLine(line) {
  const ellipsis = /tskey-(?:api|client|auth)-(?:…|\.{3})/g;
  if (!ellipsis.test(line)) return false;
  const stripped = line.replace(/tskey-(?:api|client|auth)-(?:…|\.{3})/g, "");
  return !hasLiteral(stripped);
}

/** A line whose only key-shaped text sits inside a regex literal. */
function isRegexOnlyLine(line) {
  const spans = regexSpans(line);
  if (spans.length === 0) return false;
  const matches = literalMatches(line);
  return matches.length > 0 && matches.every((match) => insideSpan(match.index ?? 0, spans));
}

function lineViolates(relPath, line) {
  if (!hasLiteral(line)) return false;
  if (isTokenRegexLine(relPath, line)) return false;
  if (isEllipsisPlaceholderLine(line)) return false;
  if (isRegexOnlyLine(line)) return false;
  return true;
}

/**
 * @param {{ root?: string, files?: readonly string[] }} [options]
 * `files` scans those repo-relative paths. Otherwise scan tracked files plus
 * untracked files git is not ignoring.
 * @returns {string[]} `path:line` violations, sorted.
 */
export function findTskeyLiteralViolations(options = {}) {
  const root = options.root ?? gitRoot(process.cwd());
  const files = options.files ?? listedFiles(root);
  const violations = [];
  for (const relPath of files) {
    if (!isScannablePath(relPath)) continue;
    const absolute = resolve(root, relPath);
    let text;
    try {
      if (!statSync(absolute).isFile()) continue;
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lineViolates(relPath, lines[index] ?? ""))
        violations.push(`${relPath}:${index + 1}`);
    }
  }
  violations.sort();
  return violations;
}

function main() {
  const json = process.argv.includes("--json");
  const violations = findTskeyLiteralViolations();
  if (json) {
    console.log(JSON.stringify(violations));
  }
  if (violations.length === 0) {
    if (!json) console.log("tskey literal gate: CLEAN");
    return;
  }
  if (!json) {
    console.error("tskey literal gate: FAIL");
    for (const violation of violations) console.error(violation);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main();
