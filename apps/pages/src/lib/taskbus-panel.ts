/**
 * Pure TaskBus panel helpers (testable without React DOM).
 */

import type { TaskBusConfig } from "./taskbus.js";

export type TaskBusFlashTone = "ok" | "err" | "warn";

export function taskBusControlsDisabled(
  config: TaskBusConfig | null,
  busy: boolean,
): boolean {
  return busy || config?.source === "env";
}

export function taskBusSaveFlash(
  applied: boolean,
  config: TaskBusConfig,
) {
  if (applied) {
    return { tone: "ok", text: "TaskBus config applied on Host." };
  }
  return {
    tone: "warn",
    text:
      config.lastError ||
      "Saved — Host could not connect yet. Fix Tailscale reachability and Ping.",
  };
}

export function taskBusPingFlash(
  ok: boolean,
  config: TaskBusConfig,
) {
  if (ok) {
    return { tone: "ok", text: "Host reached TaskBus / NATS." };
  }
  return {
    tone: "err",
    text: config.lastError || "Host could not reach NATS.",
  };
}

export function taskBusStatusTone(config: TaskBusConfig): "ok" | "warn" {
  if (config.lastError || config.status.includes("fail")) {
    return "warn";
  }
  return "ok";
}

export function taskBusShowNatsUrlField(backend: "memory" | "nats"): boolean {
  return backend === "nats";
}

export function taskBusEnvOverrideNotice(
  source: TaskBusConfig["source"],
): boolean {
  return source === "env";
}
