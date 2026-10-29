import { z } from "zod";
import type { BoatJsonValue } from "./boat-client.js";

const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

/** A Boat API error with its stable machine-readable code. */
export class BoatApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(input: { code: string; status: number; message: string }) {
    super(`boat: ${input.message} (${input.code})`);
    this.name = "BoatApiError";
    this.code = input.code;
    this.status = input.status;
  }
}

export function boatApiError(raw: BoatJsonValue, status: number): BoatApiError {
  const parsed = errorEnvelopeSchema.safeParse(raw);
  const code =
    (parsed.success
      ? (parsed.data.code ?? parsed.data.error?.code)
      : undefined) ?? `http_${status}`;
  const message =
    (parsed.success
      ? (parsed.data.message ?? parsed.data.error?.message)
      : undefined) ?? `HTTP ${status}`;
  return new BoatApiError({ code, status, message });
}
