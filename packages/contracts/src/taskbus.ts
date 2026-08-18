import { z } from "zod";

/**
 * Host operator TaskBus / NATS wire contract (Pages proxy).
 * Snake_case on the wire; strict — no secrets beyond semi-public NATS URL.
 */

export const TaskBusBackendSchema = z.enum(["memory", "nats"]);
export type TaskBusBackendWire = z.infer<typeof TaskBusBackendSchema>;

export const TaskBusSourceSchema = z.enum(["env", "stored", "default"]);
export type TaskBusSourceWire = z.infer<typeof TaskBusSourceSchema>;

/** NATS protocol URLs — not http(s). */
export const NatsUrlSchema = z
  .string()
  .min(1)
  .refine(
    (u) => {
      const lower = u.toLowerCase();
      return lower.startsWith("nats://") || lower.startsWith("tls://");
    },
    { message: "nats_url must start with nats:// or tls://" },
  );

export const TaskBusConfigSchema = z
  .object({
    backend: TaskBusBackendSchema,
    nats_url: NatsUrlSchema.nullable().optional(),
    source: TaskBusSourceSchema,
    status: z.string().min(1),
    last_error: z.string().nullable().optional(),
  })
  .strict();
export type TaskBusConfigWire = z.infer<typeof TaskBusConfigSchema>;

export const GetTaskBusResponseSchema = z
  .object({
    taskbus: TaskBusConfigSchema,
  })
  .strict();

export const PutTaskBusRequestSchema = z
  .object({
    backend: TaskBusBackendSchema,
    nats_url: NatsUrlSchema.optional(),
  })
  .strict();

export const PutTaskBusResponseSchema = z
  .object({
    taskbus: TaskBusConfigSchema,
    applied: z.boolean().optional(),
    hint: z.string().optional(),
  })
  .strict();

export const PingTaskBusResponseSchema = z
  .object({
    ok: z.boolean(),
    taskbus: TaskBusConfigSchema,
    hint: z.string().optional(),
  })
  .strict();

/** Reject credential / token material on TaskBus responses. */
export const FORBIDDEN_TASKBUS_RESPONSE_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "webhook_secret",
  "private_key",
  "pem",
] as const;
