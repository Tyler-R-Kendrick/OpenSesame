/**
 * Durable-enough pending webhook nudges for the Connect relay.
 *
 * Prefer Upstash Redis REST when KV_REST_API_URL + KV_REST_API_TOKEN are set
 * (shared across Vercel isolates). Else a JSON file when not on Vercel
 * (long-lived node server / tests). Vercel without Redis refuses enqueue so
 * GitHub redelivers instead of acknowledging a lost nudge.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PENDING = 32;
const REDIS_KEY = "opensesame:github-app:webhook-pending";

/** @typedef {{ id: string, installationId: string | null, receivedAt: string }} WebhookNudge */

/** @type {WebhookNudge[]} */
let memoryQueue = [];

function queuePath() {
  const raw =
    typeof process !== "undefined" && process.env.CONNECT_WEBHOOK_QUEUE_PATH
      ? String(process.env.CONNECT_WEBHOOK_QUEUE_PATH).trim()
      : "";
  if (raw) return raw;
  if (typeof process !== "undefined" && process.env.VERCEL) return null;
  return "/tmp/opensesame-github-webhook-queue.json";
}

function redisConfig() {
  const url =
    typeof process !== "undefined" && process.env.KV_REST_API_URL
      ? String(process.env.KV_REST_API_URL).trim()
      : "";
  const token =
    typeof process !== "undefined" && process.env.KV_REST_API_TOKEN
      ? String(process.env.KV_REST_API_TOKEN).trim()
      : "";
  if (!url || !token) return null;
  return { url, token };
}

function onVercel() {
  return typeof process !== "undefined" && Boolean(process.env.VERCEL);
}

/**
 * @param {WebhookNudge[]} events
 */
function clamp(events) {
  if (events.length <= MAX_PENDING) return events;
  return events.slice(events.length - MAX_PENDING);
}

/**
 * @returns {WebhookNudge[]}
 */
function readFileQueue() {
  const path = queuePath();
  if (!path) return memoryQueue;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.id === "string" &&
        typeof row.receivedAt === "string",
    );
  } catch {
    return [];
  }
}

/**
 * @param {WebhookNudge[]} events
 */
function writeFileQueue(events) {
  const path = queuePath();
  if (!path) {
    memoryQueue = events;
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(events), "utf8");
}

/**
 * @param {string} command
 * @param {unknown[]} args
 */
async function redisCommand(command, args) {
  const cfg = redisConfig();
  if (!cfg) return null;
  const response = await fetch(`${cfg.url}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command, ...args]),
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {string | null} installationId
 */
function redisListKey(installationId) {
  return `${REDIS_KEY}:${installationId || "unknown"}`;
}

/**
 * @param {WebhookNudge} event
 */
export async function enqueueWebhookNudge(event) {
  if (redisConfig()) {
    const key = redisListKey(event.installationId);
    const pushed = await redisCommand("RPUSH", [key, JSON.stringify(event)]);
    if (pushed == null || pushed.result == null) {
      throw new Error("queue_persist_failed");
    }
    const trimmed = await redisCommand("LTRIM", [key, -MAX_PENDING, -1]);
    if (trimmed == null) {
      throw new Error("queue_persist_failed");
    }
    return;
  }
  if (onVercel()) {
    throw new Error("queue_unavailable");
  }
  const next = clamp([...readFileQueue(), event]);
  writeFileQueue(next);
}

/**
 * @param {string | null} installationId
 * @returns {Promise<WebhookNudge[]>}
 */
export async function drainWebhookNudges(installationId) {
  if (redisConfig()) {
    const key = redisListKey(installationId);
    /** @type {WebhookNudge[]} */
    const matched = [];
    while (matched.length < MAX_PENDING) {
      const popped = await redisCommand("LPOP", [key]);
      if (popped == null) {
        throw new Error("queue_drain_failed");
      }
      if (popped.result == null) break;
      if (typeof popped.result !== "string") continue;
      try {
        const event = JSON.parse(popped.result);
        if (event && typeof event.id === "string") matched.push(event);
      } catch {
        /* skip corrupt */
      }
    }
    return matched;
  }
  if (onVercel()) {
    return [];
  }
  const all = readFileQueue();
  const matched = installationId
    ? all.filter((e) => e.installationId === installationId)
    : all;
  const keep = installationId
    ? all.filter((e) => e.installationId !== installationId)
    : [];
  writeFileQueue(keep);
  return matched;
}

/** Test helper — drop queued webhook nudges. */
export function clearWebhookQueue() {
  memoryQueue = [];
  const path = queuePath();
  if (path) {
    try {
      writeFileSync(path, "[]", "utf8");
    } catch {
      /* ignore */
    }
  }
}
