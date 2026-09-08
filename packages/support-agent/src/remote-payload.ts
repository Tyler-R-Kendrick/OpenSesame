import type { SupportRequest } from "./contract.js";
import { SupportEgressRefused } from "./egress.js";

export const REMOTE_QUESTION_LIMIT = 2000;
export const REMOTE_PAYLOAD_BYTES = 8192;

/** Best-effort pattern redaction, never a claim to recognize arbitrary prose secrets. */
export function redactSupportQuestion(question: string): string {
  if (question.length > REMOTE_QUESTION_LIMIT)
    throw new SupportEgressRefused("question", "exceeds remote limit");
  return question
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
      "[redacted key]",
    )
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "[redacted URL]")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[redacted address]",
    )
    .replace(
      /\b(?:bearer|password|secret|token|api[_ -]?key|username)\s*[:= ]\s*[^\s,;]+/gi,
      "[redacted credential]",
    )
    .replace(
      /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\b/g,
      "[redacted token]",
    )
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, "[redacted identifier]")
    .replace(/\b(?:\d[ -]?){6,19}\b/g, "[redacted number]");
}

export type RemoteSupportPayload = {
  readonly version: 2;
  readonly question: string;
  readonly pageId: string;
  readonly route: string;
  readonly featureIds: readonly string[];
};

function identifier(value: string): string {
  if (!/^\/?[a-z][a-z0-9._/-]{0,63}$/.test(value) || value.includes("//"))
    throw new SupportEgressRefused("identifier", "is not a semantic ID");
  return value;
}

/** No history, values, labels, predicates, tool status, URLs, or DOM-derived data. */
export function remoteSupportPayload(
  request: SupportRequest,
): RemoteSupportPayload {
  const result: RemoteSupportPayload = Object.freeze({
    version: 2,
    question: redactSupportQuestion(request.question),
    pageId: identifier(request.context.pageId),
    route: identifier(request.context.route),
    featureIds: Object.freeze(
      request.context.goals.slice(0, 32).map((goal) => identifier(goal.id)),
    ),
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    REMOTE_PAYLOAD_BYTES
  )
    throw new SupportEgressRefused("payload", "exceeds remote limit");
  return result;
}
