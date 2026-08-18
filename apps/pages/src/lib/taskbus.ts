/**
 * Host TaskBus / NATS configuration client.
 * Browser never dials nats:// — Host reaches NATS (loopback or Tailscale).
 */

import { hostFetch } from "./identity.js";

export type TaskBusBackend = "memory" | "nats";
export type TaskBusSource = "env" | "stored" | "default";

export type TaskBusConfig = {
  backend: TaskBusBackend;
  natsUrl: string | null;
  source: TaskBusSource;
  status: string;
  lastError: string | null;
};

async function fail(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    hint?: string;
    error?: string;
  };
  throw new Error(body.hint || body.error || `${fallback} (${res.status})`);
}

function toConfig(raw: Record<string, unknown>): TaskBusConfig {
  const backend = String(raw.backend ?? "memory");
  return {
    backend: backend === "nats" ? "nats" : "memory",
    natsUrl: (raw.nats_url as string | null) ?? null,
    source: (String(raw.source ?? "default") as TaskBusSource) || "default",
    status: String(raw.status ?? "ok"),
    lastError: (raw.last_error as string | null) ?? null,
  };
}

export async function getTaskBusConfig(): Promise<TaskBusConfig> {
  const res = await hostFetch("/api/v1/operator/taskbus");
  if (!res.ok) await fail(res, "Could not read TaskBus config");
  const body = (await res.json()) as { taskbus?: Record<string, unknown> };
  return toConfig(body.taskbus ?? {});
}

export async function putTaskBusConfig(input: {
  backend: TaskBusBackend;
  natsUrl?: string;
}): Promise<{ config: TaskBusConfig; applied: boolean }> {
  const res = await hostFetch("/api/v1/operator/taskbus", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      backend: input.backend,
      ...(input.natsUrl ? { nats_url: input.natsUrl } : {}),
    }),
  });
  if (!res.ok) await fail(res, "Could not save TaskBus config");
  const body = (await res.json()) as {
    taskbus?: Record<string, unknown>;
    applied?: boolean;
  };
  return {
    config: toConfig(body.taskbus ?? {}),
    applied: Boolean(body.applied),
  };
}

export async function pingTaskBus(): Promise<{
  ok: boolean;
  config: TaskBusConfig;
}> {
  const res = await hostFetch("/api/v1/operator/taskbus/ping", {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    taskbus?: Record<string, unknown>;
    hint?: string;
  };
  if (!res.ok && res.status !== 422) {
    throw new Error(body.hint || `TaskBus ping failed (${res.status})`);
  }
  return {
    ok: Boolean(body.ok),
    config: toConfig(body.taskbus ?? {}),
  };
}
