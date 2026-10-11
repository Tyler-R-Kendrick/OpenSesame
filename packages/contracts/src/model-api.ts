import { z } from "zod";

/**
 * How a hosted model row is spoken to (ADR 0188). The protocol is a closed
 * name; a row never carries a path or a header, so it cannot teach the broker
 * a new way to reach a host.
 */
export const ModelProtocolSchema = z.enum([
  "openai_chat",
  "anthropic_messages",
  "gemini_generate_content",
  "rest_json",
]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;

export const ModelApiSchema = z
  .object({
    protocol: ModelProtocolSchema,
    /** Absent when the endpoint is the person's own (a configuration row). */
    base_url: z.string().url().optional(),
  })
  .strict();
export type ModelApi = z.infer<typeof ModelApiSchema>;
