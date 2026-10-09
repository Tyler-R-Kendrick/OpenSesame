import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";
const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_CLIENT_BUDGET = 60;
const PUBLIC_GLOBAL_BUDGET = 1_000;
const PUBLIC_FENCE_ENTRIES = 4_096;

export function consumePublicBudget(c: {
  req: { header: (name: string) => string | undefined; path: string };
  get: (name: "ctx") => AppContext;
}): boolean {
  const now = Date.now();
  const map = c.get("ctx").stores.authenticationAnon;
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < PUBLIC_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  while (map.size > PUBLIC_FENCE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const fingerprint = createHash("sha256")
    .update(c.req.path.split("/").slice(0, 6).join("/"))
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? c.req.header("x-forwarded-for") ?? "")
    .digest("hex")
    .slice(0, 16);
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (
    global.length >= PUBLIC_GLOBAL_BUDGET ||
    client.length >= PUBLIC_CLIENT_BUDGET
  ) {
    return false;
  }
  map.set("__global__", [...global, now]);
  map.set(fingerprint, [...client, now]);
  return true;
}
