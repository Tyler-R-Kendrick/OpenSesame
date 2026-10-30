/** Host response contracts used by the password-reset notice and takeover UI. */
import { z } from "zod";

const nullableText = z.string().nullable().optional();

export const hostAgentRunSchema = z.object({
  id: z.string(),
  job_id: nullableText,
  origin: z.string().optional(),
  control_state: z.string(),
  driver: z.string().optional(),
  blocked_reason: nullableText,
  lease_expires_at: nullableText,
  closed_at: nullableText,
  observation: z.string().optional(),
});

export const hostAgentRunListSchema = z.object({
  runs: z.array(z.json()),
});

export const hostRotationReceiptSchema = z.object({ id: z.string() });

export const hostRotationJobSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
});

export const hostHandoffReceiptSchema = z.object({
  status: z.enum(["accepted", "queued"]),
  hint: z.string(),
});

export const hostClaimedStepSchema = z.object({
  run_id: z.string(),
  seq: z.number(),
  request: z
    .object({
      step: z.string().optional(),
      selector: z.string().optional(),
      url: z.string().optional(),
    })
    .catchall(z.json()),
  claim_expires_at: nullableText,
});

export const hostHookRecordSchema = z.object({
  sequence: z.number(),
  interception_point: z.string(),
  decision: z.string(),
  reason: nullableText,
  recorded_at: z.string(),
});

export const hostHookRecordsSchema = z.object({
  run_id: z.string(),
  records: z.array(z.json()),
  next_after: z.json().optional(),
  has_more: z.json().optional(),
});
