import {
  GetTaskBusResponseSchema,
  PutTaskBusRequestSchema,
  TaskBusConfigSchema,
} from "@opensesame/contracts";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeRemainingAsString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const config = TaskBusConfigSchema.safeParse(parsed);
  if (config.success) {
    const body = JSON.stringify(config.data);
    for (const leak of [
      "access_token",
      "refresh_token",
      "client_secret",
      "webhook_secret",
      "BEGIN RSA",
    ]) {
      if (body.includes(leak)) {
        throw new Error(`taskbus config leaked forbidden field: ${leak}`);
      }
    }
    if (
      config.data.nats_url &&
      !config.data.nats_url.startsWith("nats://") &&
      !config.data.nats_url.startsWith("tls://")
    ) {
      throw new Error("nats_url must use nats:// or tls:// when present");
    }
  }

  const get = GetTaskBusResponseSchema.safeParse(parsed);
  if (get.success && get.data.taskbus.backend === "memory") {
    // memory backend must not require nats_url for panel rendering
    if (get.data.taskbus.nats_url?.includes("http://")) {
      throw new Error("http nats_url must not parse");
    }
  }

  const put = PutTaskBusRequestSchema.safeParse(parsed);
  if (put.success && put.data.backend === "nats" && put.data.nats_url) {
    const u = put.data.nats_url.toLowerCase();
    if (u.startsWith("http://") || u.startsWith("https://")) {
      throw new Error("PUT must reject http(s) nats_url");
    }
  }
}
