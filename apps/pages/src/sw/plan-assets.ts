/**
 * Save an approved plan's assets for offline use (PWA-05, PWA-07, PWA-09).
 *
 * The page names module ids; this module turns them into files through the
 * release's `capability-graph.json`, downloads those files — and only those —
 * into a staging cache, and moves them into the release cache only once every
 * one of them arrived. A download that comes up short leaves both the
 * previous release's cache and whatever the current release already holds
 * exactly as they were, and says how many files are missing. A storage
 * refusal (quota) is reported, never thrown.
 */

import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { type WorkerContext, controlledSender } from "./context.js";
import {
  type CapabilityGraph,
  parseCapabilityGraph,
  resolvePlanAssets,
} from "./graph.js";
import {
  type PlanAssetsMessage,
  type PlanRejectReason,
  type WorkerToPageMessage,
  parsePlanAssets,
} from "./messages.js";

export const GRAPH_FILE = "capability-graph.json";

type StageOutcome =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "partial"; missing: number }>
  | Readonly<{ kind: "storage-unavailable" }>;

function isQuotaError(error: BoundaryValue | Error): boolean {
  // SAFETY: a DOMException or Error carries `name`; anything else reads
  // undefined and is not a quota refusal.
  const named: { name?: string } = overlapCast(error);
  return named.name === "QuotaExceededError";
}

function post(client: Client, message: WorkerToPageMessage): void {
  try {
    client.postMessage(message);
  } catch {
    // The window went away; there is nobody to tell.
  }
}

async function readGraph(ctx: WorkerContext): Promise<CapabilityGraph | null> {
  const url = new URL(GRAPH_FILE, ctx.scopeUrl).href;
  const cache = await ctx.caches.open(ctx.releaseCacheName);
  try {
    const response = await ctx.fetch(url);
    if (response.ok && response.type !== "opaque") {
      await cache.put(url, response.clone()).catch(() => undefined);
      return parseCapabilityGraph(await response.json());
    }
  } catch {
    // Offline: the copy saved under this release, if any, answers below.
  }
  const cached = await cache.match(url);
  if (!cached) return null;
  try {
    return parseCapabilityGraph(await cached.json());
  } catch {
    return null;
  }
}

async function alreadySaved(release: Cache, url: string): Promise<boolean> {
  try {
    return (await release.match(url)) !== undefined;
  } catch {
    return false;
  }
}

async function stageFiles(
  ctx: WorkerContext,
  files: readonly string[],
): Promise<StageOutcome> {
  const release = await ctx.caches.open(ctx.releaseCacheName);
  const staging = await ctx.caches.open(ctx.stagingCacheName);
  let missing = 0;
  const staged: string[] = [];
  for (const file of files) {
    const url = new URL(file, ctx.scopeUrl).href;
    if (await alreadySaved(release, url)) continue;
    try {
      const response = await ctx.fetch(url);
      if (!response.ok || response.type === "opaque") {
        missing += 1;
        continue;
      }
      await staging.put(url, response);
      staged.push(url);
    } catch (error) {
      if (isQuotaError(overlapCast(error)))
        return { kind: "storage-unavailable" };
      missing += 1;
    }
  }
  if (missing > 0) return { kind: "partial", missing };
  for (const url of staged) {
    const response = await staging.match(url);
    if (!response) return { kind: "partial", missing: 1 };
    try {
      await release.put(url, response);
    } catch (error) {
      if (isQuotaError(overlapCast(error)))
        return { kind: "storage-unavailable" };
      return { kind: "partial", missing: 1 };
    }
  }
  return { kind: "complete" };
}

async function runPlan(
  ctx: WorkerContext,
  client: Client,
  plan: PlanAssetsMessage,
): Promise<void> {
  const graph = await readGraph(ctx);
  if (!graph)
    return post(client, { type: "PLAN_REJECTED", reason: "graph-unavailable" });
  const resolved = resolvePlanAssets(graph, plan.moduleIds);
  if (!resolved.ok)
    return post(client, { type: "PLAN_REJECTED", reason: "unknown-module" });
  let outcome: StageOutcome;
  try {
    outcome = await stageFiles(ctx, resolved.files);
  } catch (error) {
    outcome = isQuotaError(overlapCast(error))
      ? { kind: "storage-unavailable" }
      : { kind: "partial", missing: resolved.files.length };
  } finally {
    await ctx.caches.delete(ctx.stagingCacheName).catch(() => false);
  }
  const identity = { releaseId: ctx.releaseId, planDigest: plan.planDigest };
  if (outcome.kind === "complete")
    post(client, { type: "OFFLINE_READY", ...identity });
  else if (outcome.kind === "partial")
    post(client, {
      type: "OFFLINE_PARTIAL",
      ...identity,
      missing: outcome.missing,
    });
  else post(client, { type: "OFFLINE_STORAGE_UNAVAILABLE", ...identity });
}

/** One plan at a time per worker; a second request waits for the first. */
export class PlanCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: WorkerContext) {}

  /**
   * Admit a `PLAN_ASSETS` message. The sender is checked before the payload
   * is even parsed: a message from anything but a controlled same-scope
   * window is dropped without a reply, a fetch or a delete.
   */
  async handle(event: ExtendableMessageEvent): Promise<void> {
    const client = await controlledSender(this.ctx, event.source);
    if (!client) return;
    const parsed = parsePlanAssets(event.data);
    if (!parsed.ok) return this.reject(client, parsed.reason);
    if (parsed.message.releaseId !== this.ctx.releaseId)
      return this.reject(client, "release-mismatch");
    const run = this.queue.then(() =>
      runPlan(this.ctx, client, parsed.message),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private reject(client: Client, reason: PlanRejectReason): void {
    post(client, { type: "PLAN_REJECTED", reason });
  }
}
