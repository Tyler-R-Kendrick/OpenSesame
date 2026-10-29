import type { JsonValue } from "@opensesame/os-domain";
import {
  type Decision,
  type DecisionCandidate,
  type HumanChallenge,
  type Observation,
  type ResetActionDecision,
  decisionSchema,
} from "./types.js";

const CHALLENGE =
  /captcha|verify you are human|one.time code|mail_code|text message|passkey|security key|two.factor|2fa|authenticator|totp/iu;

export type DecisionWire = JsonValue | undefined;

export interface DecisionsApi {
  decide(input: {
    observation: Observation;
    candidates: readonly DecisionCandidate[];
  }): Promise<DecisionWire>;
}

export function modelObservation(observation: Observation): Observation {
  if (observation.screenshot && !observation.maskedScreenshot)
    throw new Error("A screenshot must be masked before model observation");
  const sensitive = observation.sensitiveValues ?? [];
  const redact = (label: string, kind: string) => {
    if (kind === "password") return "[masked password]";
    if (kind === "otp")
      return /mail|email/iu.test(label)
        ? "[masked mail_code]"
        : "[masked totp]";
    return sensitive
      .reduce((text, value) => text.replaceAll(value, "[redacted]"), label)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/gu, "[redacted]");
  };
  const safe: Observation = {
    id: observation.id,
    origin: observation.origin,
    fields: observation.fields.map(({ ref, kind, label }) => ({
      ref,
      kind,
      label: redact(label, kind),
    })),
  };
  if (observation.maskedScreenshot)
    safe.maskedScreenshot = observation.maskedScreenshot;
  const serialized = JSON.stringify(safe);
  if (sensitive.some((value) => serialized.includes(value)))
    throw new Error("Sensitive value survived observation masking");
  return safe;
}

export function detectChallenge(
  observation: Observation,
): HumanChallenge | null {
  const text = observation.fields.map((field) => field.label).join(" ");
  if (!CHALLENGE.test(text)) return null;
  if (/captcha|verify you are human/iu.test(text)) return "captcha";
  if (/passkey|security key/iu.test(text)) return "passkey";
  if (/text message/iu.test(text)) return "sms";
  if (/authenticator|totp/iu.test(text)) return "totp";
  if (/one.time code|mail_code|email code|code from email/iu.test(text))
    return "mail_code";
  return "two_fa";
}

export function legalCandidates(observation: Observation): DecisionCandidate[] {
  const actions = observation.fields.flatMap((field): ResetActionDecision[] => {
    if (field.kind === "static") return [];
    if (field.kind === "button" || field.kind === "link") {
      const click: ResetActionDecision = {
        kind: "click",
        observationId: observation.id,
        ref: field.ref,
      };
      if (
        field.kind === "button" &&
        /reset|submit|save|change password|set password|update password/iu.test(
          field.label,
        )
      )
        return [
          click,
          { kind: "submit", observationId: observation.id, ref: field.ref },
        ];
      return [click];
    }
    if (field.kind === "otp")
      return [
        {
          kind: "await-human",
          observationId: observation.id,
          challenge: detectChallenge(observation) ?? "two_fa",
        },
      ];
    if (field.kind === "password")
      return [
        {
          kind: "fill-field",
          observationId: observation.id,
          ref: field.ref,
          purpose: "new-password",
        },
      ];
    return [
      {
        kind: "fill-field",
        observationId: observation.id,
        ref: field.ref,
        purpose: "identifier",
      },
    ];
  });
  actions.push(
    { kind: "navigate", observationId: observation.id },
    { kind: "await-email-link", observationId: observation.id },
    { kind: "verify-login", observationId: observation.id },
  );
  const challenge = detectChallenge(observation);
  if (challenge)
    actions.push({
      kind: "await-human",
      observationId: observation.id,
      challenge,
    });
  return actions.map((action, index) => ({
    id: `c${index + 1}`,
    effectId: `${observation.id}:effect-${index + 1}`,
    action,
  }));
}

export function guardDecision(
  raw: DecisionWire,
  observation: Observation,
  allowedOrigins: readonly string[],
): Decision {
  if (!allowedOrigins.includes(observation.origin))
    throw new Error("Observation origin is outside the reset grant");
  const decision = decisionSchema.parse(raw);
  if (decision.observationId !== observation.id)
    throw new Error("Decision used a stale observation");
  if (decision.kind === "act") {
    const candidate = legalCandidates(observation).find(
      ({ id }) => id === decision.candidateId,
    );
    if (!candidate || candidate.effectId !== decision.effectId)
      throw new Error("Decision is not a legal typed candidate");
  }
  if (
    decision.kind === "handoff" &&
    detectChallenge(observation) !== decision.challenge
  )
    throw new Error("Decision invented a human challenge");
  return decision;
}

export async function decide(
  api: DecisionsApi,
  observation: Observation,
  allowedOrigins: readonly string[],
): Promise<Decision> {
  const safe = modelObservation(observation);
  return guardDecision(
    await api.decide({ observation: safe, candidates: legalCandidates(safe) }),
    safe,
    allowedOrigins,
  );
}

export function selectedAction(
  decision: Decision,
  observation: Observation,
): ResetActionDecision {
  if (decision.kind !== "act") throw new Error("Decision is not an action");
  const candidate = legalCandidates(observation).find(
    ({ id, effectId }) =>
      id === decision.candidateId && effectId === decision.effectId,
  );
  if (!candidate) throw new Error("Decision candidate is no longer legal");
  return candidate.action;
}
