/**
 * RFC 8693 §2.1: the token exchange request, parsed strictly.
 *
 * The parameters arrive as flat strings, the way a form or a channel message
 * carries them. Anything this exchange does not define is refused rather than
 * ignored: an ignored parameter is a request the caller believes was honoured,
 * and `actor_token` or `client_id` quietly dropped would be exactly that.
 */
import {
  type BoundaryValue,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { canonicalResource } from "./resource.js";
import {
  ACCESS_TOKEN_TYPE,
  KEY_PATTERN,
  LIMITS,
  type ModelAction,
  TOKEN_EXCHANGE_GRANT,
  isModelAction,
} from "./vocabulary.js";

const KNOWN = new Set([
  "grant_type",
  "subject_token",
  "subject_token_type",
  "requested_token_type",
  "resource",
  "audience",
  "scope",
  "authorization_details",
  "dpop_jkt",
]);
/** Defined by RFC 8693 but not offered: a key is delegated to a key, never to a second token. */
const UNOFFERED = new Set(["actor_token", "actor_token_type"]);

const SCOPE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const JKT = /^[A-Za-z0-9_-]{43}$/;
const AUDIENCE = /^urn:opensesame:model:[a-z0-9][a-z0-9-]{0,63}$/;

export type ExchangeRequest = Readonly<{
  subjectToken: string;
  resource: string | null;
  /** The provider id an `audience` names, when one was given. */
  audienceProvider: string | null;
  actions: readonly ModelAction[] | null;
  /** Parsed, not yet validated: `details.ts` owns the RAR vocabulary. */
  details: readonly JsonValue[] | null;
  dpopJkt: string | null;
}>;

function strings(input: BoundaryValue): Record<string, string> {
  if (!isJsonObject(input)) return refuse("invalid_request", "request.shape");
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null)
    return refuse("invalid_request", "request.shape");
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > LIMITS.maxParams)
    return refuse("invalid_request", "request.size");
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    if (UNOFFERED.has(key)) return refuse("invalid_request", `param.${key}`);
    if (!KNOWN.has(key)) return refuse("invalid_request", "param.unknown");
    if (!isString(value) || value.length > LIMITS.maxParamLength)
      return refuse("invalid_request", "param.value");
    out[key] = value;
  }
  return out;
}

function parseScope(value: string | undefined): readonly ModelAction[] | null {
  if (value === undefined) return null;
  const tokens = value.split(" ");
  if (tokens.length > 8 || tokens.some((token) => !SCOPE_TOKEN.test(token)))
    return refuse("invalid_scope", "scope.shape");
  const actions: ModelAction[] = [];
  for (const token of tokens) {
    if (!isModelAction(token)) return refuse("invalid_scope", "scope.unknown");
    if (actions.includes(token))
      return refuse("invalid_scope", "scope.duplicate");
    actions.push(token);
  }
  return actions;
}

function parseDetails(value: string | undefined): readonly JsonValue[] | null {
  if (value === undefined) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse("invalid_authorization_details", "details.json");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4)
    return refuse("invalid_authorization_details", "details.shape");
  return parsed;
}

export function parseExchangeRequest(input: BoundaryValue): ExchangeRequest {
  const params = strings(input);
  if (params.grant_type !== TOKEN_EXCHANGE_GRANT)
    return refuse("unsupported_grant_type", "grant_type");
  const subject = params.subject_token;
  if (subject === undefined || params.subject_token_type === undefined)
    return refuse("invalid_request", "subject.missing");
  if (params.subject_token_type !== ACCESS_TOKEN_TYPE)
    return refuse("invalid_request", "subject.type");
  if (
    params.requested_token_type !== undefined &&
    params.requested_token_type !== ACCESS_TOKEN_TYPE
  )
    return refuse("invalid_request", "requested.type");
  if (!KEY_PATTERN.test(subject))
    return refuse("invalid_grant", "subject.shape");
  const audience = params.audience;
  if (audience !== undefined && !AUDIENCE.test(audience))
    return refuse("invalid_target", "audience.shape");
  const jkt = params.dpop_jkt;
  if (jkt !== undefined && !JKT.test(jkt))
    return refuse("invalid_request", "dpop_jkt.shape");
  return {
    subjectToken: subject,
    resource:
      params.resource === undefined ? null : canonicalResource(params.resource),
    audienceProvider: audience
      ? audience.slice("urn:opensesame:model:".length)
      : null,
    actions: parseScope(params.scope),
    details: parseDetails(params.authorization_details),
    dpopJkt: jkt ?? null,
  };
}

/** Parameters from a query or form string, refusing a name given twice (RFC 6749 §3.1). */
export function paramsFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(out, key))
      return refuse("invalid_request", "param.duplicate");
    out[key] = value;
  }
  return out;
}
