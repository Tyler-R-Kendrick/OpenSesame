#!/usr/bin/env node
/**
 * Kimi parallel lane: defer paths that hit the per-file wall or CLI error.
 * Usage:
 *   node deepsec-wave2-kimi-deferred.mjs path <repoRoot> <filePath> <reason>
 *   node deepsec-wave2-kimi-deferred.mjs list <repoRoot>
 */
import fs from "node:fs";
import path from "node:path";

export function kimiDeferredStorePath(repoRoot) {
  return path.join(repoRoot, ".deepsec", "wave2-kimi-deferred.json");
}

export function loadKimiDeferred(repoRoot) {
  const p = kimiDeferredStorePath(repoRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw.entries)) return { entries: [] };
    return raw;
  } catch {
    return { entries: [] };
  }
}

export function kimiDeferredPathSet(repoRoot) {
  const set = new Set();
  for (const e of loadKimiDeferred(repoRoot).entries) {
    if (typeof e.filePath === "string") set.add(e.filePath);
  }
  return set;
}

export function addKimiDeferred(repoRoot, filePath, reason) {
  const store = loadKimiDeferred(repoRoot);
  const now = new Date().toISOString();
  const idx = store.entries.findIndex((e) => e.filePath === filePath);
  const row = {
    filePath,
    reason: String(reason ?? "unknown"),
    deferredAt: now,
    attempts: 1,
  };
  if (idx >= 0) {
    row.attempts = (store.entries[idx].attempts ?? 1) + 1;
    store.entries[idx] = { ...store.entries[idx], ...row };
  } else {
    store.entries.push(row);
  }
  const out = kimiDeferredStorePath(repoRoot);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(store, null, 2)}\n`);
  return row;
}

const [cmd, repoRoot, filePath, reason] = process.argv.slice(2);
if (cmd === "path") {
  addKimiDeferred(repoRoot ?? process.cwd(), filePath, reason);
} else if (cmd === "list") {
  process.stdout.write(`${JSON.stringify(loadKimiDeferred(repoRoot ?? process.cwd()), null, 2)}\n`);
}
