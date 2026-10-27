#!/usr/bin/env node
/**
 * Grok ordered lane: defer paths that fail (wall, CLI error) so the runner advances.
 * Usage:
 *   node deepsec-wave2-grok-deferred.mjs path <repoRoot> <filePath> <reason>
 *   node deepsec-wave2-grok-deferred.mjs list <repoRoot>
 *   node deepsec-wave2-grok-deferred.mjs is-deferred <repoRoot> <filePath>
 *   node deepsec-wave2-grok-deferred.mjs clear-reason <repoRoot> <reason>
 *   node deepsec-wave2-grok-deferred.mjs has-reason <repoRoot> <filePath> <reason>
 */
import fs from "node:fs";
import path from "node:path";

export function deferredStorePath(repoRoot) {
  return path.join(repoRoot, ".deepsec", "wave2-grok-deferred.json");
}

export function loadDeferred(repoRoot) {
  const p = deferredStorePath(repoRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw.entries)) return { entries: [] };
    return raw;
  } catch {
    return { entries: [] };
  }
}

export function deferredPathSet(repoRoot) {
  const set = new Set();
  for (const e of loadDeferred(repoRoot).entries) {
    if (typeof e.filePath === "string") set.add(e.filePath);
  }
  return set;
}

/** Paths blocked vs eligible for wall retry at manifest tail. */
export function deferredManifestBuckets(repoRoot) {
  const allDeferred = new Set();
  const wallRetry = new Set();
  for (const e of loadDeferred(repoRoot).entries) {
    if (typeof e.filePath !== "string") continue;
    allDeferred.add(e.filePath);
    if (e.reason === "file_wall_exceeded") {
      wallRetry.add(e.filePath);
    }
  }
  return { allDeferred, wallRetry };
}

/** Drop deferred rows whose reason matches (e.g. re-queue after a tooling fix). */
export function clearDeferredByReason(repoRoot, reason) {
  const store = loadDeferred(repoRoot);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.reason !== reason);
  const removed = before - store.entries.length;
  if (removed > 0) {
    const out = deferredStorePath(repoRoot);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(store, null, 2)}\n`);
  }
  return { removed, remaining: store.entries.length };
}

export function addDeferred(repoRoot, filePath, reason) {
  const store = loadDeferred(repoRoot);
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
  const out = deferredStorePath(repoRoot);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(store, null, 2)}\n`);
  return row;
}

const [cmd, repoRoot, filePath, reason] = process.argv.slice(2);
if (cmd === "path") {
  addDeferred(repoRoot ?? process.cwd(), filePath, reason);
} else if (cmd === "clear-reason") {
  const { removed, remaining } = clearDeferredByReason(
    repoRoot ?? process.cwd(),
    filePath,
  );
  process.stdout.write(
    `${JSON.stringify({ reason: filePath, removed, remaining })}\n`,
  );
} else if (cmd === "list") {
  process.stdout.write(`${JSON.stringify(loadDeferred(repoRoot ?? process.cwd()), null, 2)}\n`);
} else if (cmd === "is-deferred") {
  const set = deferredPathSet(repoRoot ?? process.cwd());
  process.exit(set.has(filePath) ? 0 : 1);
} else if (cmd === "has-reason") {
  const store = loadDeferred(repoRoot ?? process.cwd());
  const ok = store.entries.some(
    (e) => e.filePath === filePath && e.reason === reason,
  );
  process.exit(ok ? 0 : 1);
}
