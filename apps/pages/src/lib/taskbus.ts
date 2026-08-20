import {
  type JsonObject,
  overlapCast,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
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
  const body = overlapCast(await res.json().catch(() => ({})));
  throw new Error(
    readString(body.hint) ||
      readString(body.error) ||
      `${fallback} (${res.status})`,
  );
}

function toConfig(raw: JsonObject): TaskBusConfig {
  const backend = String(raw.backend ?? "memory");
  return {
    backend: backend === "nats" ? "nats" : "memory",
    natsUrl: (overlapCast(raw.nats_url)) ?? null,
    source: (overlapCast(String(raw.source ?? "default"))) || "default",
    status: String(raw.status ?? "ok"),
    lastError: (overlapCast(raw.last_error)) ?? null,
  };
}

async function getTaskBusConfigDefault(): Promise<TaskBusConfig> {
  const res = await hostFetch("/api/v1/operator/taskbus");
  if (!res.ok) await fail(res, "Could not read TaskBus config");
  const body = overlapCast(await res.json());
  return toConfig(readJsonObject(body.taskbus) ?? {});
}

async function putTaskBusConfigDefault(input: {
  backend: TaskBusBackend;
  natsUrl?: string;
}): Promise<{ config: TaskBusConfig; applied: boolean }> {
  const res = await hostFetch("/api/v1/operator/taskbus", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      backend: input.backend,
      ...(input.natsUrl ? { nats_url: input.natsUrl } : undefined),
    }),
  });
  if (!res.ok) await fail(res, "Could not save TaskBus config");
  const body = overlapCast(await res.json());
  return {
    config: toConfig(readJsonObject(body.taskbus) ?? {}),
    applied: Boolean(body.applied),
  };
}

async function pingTaskBusDefault(): Promise<{
  ok: boolean;
  config: TaskBusConfig;
}> {
  const res = await hostFetch("/api/v1/operator/taskbus/ping", {
    method: "POST",
  });
  const body = overlapCast(await res.json().catch(() => ({})));
  if (!res.ok && res.status !== 422) {
    throw new Error(
      readString(body.hint) || `TaskBus ping failed (${res.status})`,
    );
  }
  return {
    ok: Boolean(body.ok),
    config: toConfig(readJsonObject(body.taskbus) ?? {}),
  };
}

export const taskBusSeams = {
  getTaskBusConfig: getTaskBusConfigDefault,
  putTaskBusConfig: putTaskBusConfigDefault,
  pingTaskBus: pingTaskBusDefault,
};

export async function getTaskBusConfig(): Promise<TaskBusConfig> {
  return taskBusSeams.getTaskBusConfig();
}

export async function putTaskBusConfig(
  input: Parameters<typeof putTaskBusConfigDefault>[0],
): Promise<{ config: TaskBusConfig; applied: boolean }> {
  return taskBusSeams.putTaskBusConfig(input);
}

export async function pingTaskBus(): Promise<{
  ok: boolean;
  config: TaskBusConfig;
}> {
  return taskBusSeams.pingTaskBus();
}
