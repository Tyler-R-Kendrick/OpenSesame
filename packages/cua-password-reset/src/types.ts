import { z } from "zod";

export const PRIMITIVES = [
  "navigate",
  "fill-field",
  "click",
  "await-email-link",
  "enter-email-code",
  "enter-TOTP",
  "passkey-prompt",
  "await-human",
  "submit",
  "verify-login",
] as const;

export const RESET_ACTIONS = [
  "password_reset.domain_metadata.list",
  "password_reset.item.use",
  "password_reset.mailbox.read",
  "password_reset.browser.drive",
  "password_reset.runtime.execute",
  "password_reset.model.plan",
  "password_reset.proxy.substitute",
  "password_reset.password.produce",
  "password_reset.human.takeover",
  "password_reset.run.reconcile",
  "password_reset.run.compensate",
] as const;
export type ResetAction = (typeof RESET_ACTIONS)[number];

export const fieldSchema = z
  .object({
    ref: z.string().regex(/^e[1-9][0-9]*$/),
    kind: z.enum(["email", "text", "password", "otp", "button", "link"]),
    label: z.string().max(200),
  })
  .strict();
export type ObservedField = z.infer<typeof fieldSchema>;

export const observationSchema = z
  .object({
    id: z.string().min(8).max(128),
    origin: z.url(),
    fields: z.array(fieldSchema).max(100),
    screenshot: z.string().max(8_000_000).optional(),
    maskedScreenshot: z
      .string()
      .startsWith("data:image/png;base64,")
      .max(8_000_000)
      .optional(),
    sensitiveValues: z.array(z.string().min(1).max(512)).max(20).optional(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export const challengeSchema = z.enum([
  "captcha",
  "mail_code",
  "totp",
  "passkey",
  "sms",
  "two_fa",
  "unknown",
]);
export type HumanChallenge = z.infer<typeof challengeSchema>;

export const resetActionDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["navigate", "await-email-link", "verify-login"]),
      observationId: z.string().max(128),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["click", "submit", "passkey-prompt"]),
      observationId: z.string().max(128),
      ref: z.string().max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill-field"),
      observationId: z.string().max(128),
      ref: z.string().max(32),
      purpose: z.enum(["identifier", "new-password"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("await-human"),
      observationId: z.string().max(128),
      challenge: challengeSchema,
    })
    .strict(),
]);
export type ResetActionDecision = z.infer<typeof resetActionDecisionSchema>;

export const decisionCandidateSchema = z
  .object({
    id: z.string().regex(/^c[1-9][0-9]*$/),
    effectId: z.string().min(1).max(256),
    action: resetActionDecisionSchema,
  })
  .strict();
export type DecisionCandidate = z.infer<typeof decisionCandidateSchema>;

export const decisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("act"),
      observationId: z.string().max(128),
      candidateId: z.string().max(32),
      effectId: z.string().max(256),
    })
    .strict(),
  z
    .object({ kind: z.literal("wait"), observationId: z.string().max(128) })
    .strict(),
  z
    .object({
      kind: z.literal("handoff"),
      observationId: z.string().max(128),
      challenge: challengeSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("finish"), observationId: z.string().max(128) })
    .strict(),
  z
    .object({
      kind: z.literal("refuse"),
      observationId: z.string().max(128),
      reason: z.enum(["ambiguous", "unsupported", "drift", "unsafe"]),
    })
    .strict(),
]);
export type Decision = z.infer<typeof decisionSchema>;

export const recipeStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    primitive: z.enum(PRIMITIVES),
    ref: z
      .string()
      .regex(/^e[1-9][0-9]*$/)
      .optional(),
    expectedLabel: z.string().max(200).optional(),
    purpose: z
      .enum(["identifier", "new-password", "email-code", "totp"])
      .optional(),
    path: z.string().startsWith("/").max(512).optional(),
  })
  .strict();
export type RecipeStep = z.infer<typeof recipeStepSchema>;

export const proxyProofSchema = z
  .object({
    origin: z.url(),
    method: z.literal("POST"),
    path: z.string().startsWith("/").max(512),
    field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
    contentType: z.enum([
      "application/x-www-form-urlencoded",
      "application/json",
    ]),
    identityEncoding: z.literal(true),
    untransformedForm: z.literal(true),
    canaryVerified: z.literal(true),
  })
  .strict();
export type ProxyProof = z.infer<typeof proxyProofSchema>;

export const recipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    review: z.enum(["approved", "candidate"]),
    domain: z.string().regex(/^(?=.{1,253}$)[a-z0-9.-]+$/),
    entryPath: z.string().startsWith("/").max(512),
    allowedOrigins: z.array(z.url()).min(1).max(20),
    steps: z.array(recipeStepSchema).min(1).max(80),
    proxySubstitution: proxyProofSchema.optional(),
  })
  .strict();
export type ResetRecipe = z.infer<typeof recipeSchema>;

export type RunStatus =
  | "running"
  | "awaiting_human"
  | "reconciliation_required"
  | "compensation_required"
  | "succeeded"
  | "failed";

export type ResetRun = {
  id: string;
  domain: string;
  origin: string;
  itemId: string;
  transport: "cdp" | "extension" | "proxy";
  grantIds: Partial<Record<ResetAction, string>>;
  cursor: number;
  status: RunStatus;
  recipe: ResetRecipe;
  updatedAt: string;
};

export type StepOutcome =
  | "completed"
  | "waiting"
  | "reconcile"
  | "failed_before_submit"
  | "submit_indeterminate";

export type StepReceipt = {
  stepId: string;
  outcome: StepOutcome;
};

export type EffectContext = {
  effectId: string;
  attempt: number;
};

export interface ResetEffects {
  execute(
    step: RecipeStep,
    run: ResetRun,
    context: EffectContext,
  ): Promise<StepReceipt>;
  backupCandidate(run: ResetRun, context: EffectContext): Promise<void>;
  verifyCandidate(
    run: ResetRun,
    context: EffectContext,
  ): Promise<"verified" | "not_active" | "unknown">;
  promoteCandidate(run: ResetRun, context: EffectContext): Promise<void>;
  compensate(
    run: ResetRun,
    context: EffectContext,
  ): Promise<"compensated" | "unsupported" | "partial">;
}

export interface CheckpointJournal {
  load(runId: string): Promise<readonly unknown[]>;
  append(runId: string, event: unknown): Promise<void>;
}
