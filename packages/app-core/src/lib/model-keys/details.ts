/**
 * RFC 9396 authorization details for model access (ADR 0190).
 *
 * `{"type":"model_access", ...}` is the one detail type this exchange knows;
 * any other is refused whole (RFC 9396 §5). Its members are a closed list, so
 * a member that would widen something the broker has no check for cannot ride
 * along as an "extension".
 */
import {
  type BoundaryValue,
  type JsonObject,
  assertNoPaymentCredentials,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { canonicalResource } from "./resource.js";
import {
  BUDGET_KEYS,
  CAP_OUTPUT_TOKENS,
  DETAIL_TYPE,
  LIMITS,
  type ModelAction,
  isModelAction,
} from "./vocabulary.js";

const MEMBERS = new Set([
  "type",
  "locations",
  "actions",
  "models",
  "budget",
  "lifetime_seconds",
]);
/** `*`, a model id, or a namespace subtree such as `anthropic/*`. */
const MODEL_ENTRY =
  /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*(?:\/\*)?)$/;

export type ModelAccessRequest = Readonly<{
  locations: readonly string[];
  actions: readonly ModelAction[] | null;
  models: readonly string[] | null;
  budget: Readonly<Record<string, number>> | null;
  lifetimeSeconds: number | null;
}>;

function plainObject(value: BoundaryValue): JsonObject {
  if (!isJsonObject(value))
    return refuse("invalid_authorization_details", "detail.shape");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    return refuse("invalid_authorization_details", "detail.shape");
  return Object.fromEntries(Object.entries(value));
}

function integer(
  value: BoundaryValue,
  min: number,
  max: number,
  reason: string,
): number {
  if (
    !isNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return refuse("invalid_authorization_details", reason);
  return value;
}

function stringList(
  value: BoundaryValue,
  max: number,
  reason: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max)
    return refuse("invalid_authorization_details", reason);
  const out: string[] = [];
  for (const item of value) {
    if (!isString(item) || out.includes(item))
      return refuse("invalid_authorization_details", reason);
    out.push(item);
  }
  return out;
}

function parseBudget(value: BoundaryValue) {
  const raw = plainObject(value);
  const out: Record<string, number> = {};
  for (const [key, amount] of Object.entries(raw)) {
    if (!BUDGET_KEYS.includes(key))
      return refuse("invalid_authorization_details", "budget.key");
    out[key] = integer(
      amount,
      key === CAP_OUTPUT_TOKENS ? 1 : 0,
      LIMITS.maxBudget,
      "budget.value",
    );
  }
  if (Object.keys(out).length === 0)
    return refuse("invalid_authorization_details", "budget.empty");
  return out;
}

/** Is this one model entry the grammar allows: `*`, an id, or `namespace/*`? */
export function isModelEntry(entry: string): boolean {
  return entry.length <= LIMITS.maxModelLength && MODEL_ENTRY.test(entry);
}

function parseModels(value: BoundaryValue): string[] {
  const models = stringList(value, LIMITS.maxModelsPerKey, "models.shape");
  for (const entry of models) {
    if (!isModelEntry(entry))
      return refuse("invalid_authorization_details", "models.entry");
  }
  return models;
}

function parseActions(value: BoundaryValue): ModelAction[] {
  const actions: ModelAction[] = [];
  for (const item of stringList(value, 4, "actions.shape")) {
    if (!isModelAction(item))
      return refuse("invalid_authorization_details", "actions.unknown");
    actions.push(item);
  }
  return actions;
}

export function parseModelAccessDetails(
  details: readonly BoundaryValue[],
): ModelAccessRequest {
  if (details.length !== 1)
    return refuse("invalid_authorization_details", "details.count");
  const detail = plainObject(details[0]);
  if (detail.type !== DETAIL_TYPE)
    return refuse("invalid_authorization_details", "detail.type");
  for (const key of Object.keys(detail)) {
    if (!MEMBERS.has(key))
      return refuse("invalid_authorization_details", "detail.member");
  }
  try {
    assertNoPaymentCredentials(detail);
  } catch {
    return refuse("invalid_authorization_details", "detail.payment");
  }
  const locations =
    detail.locations === undefined
      ? []
      : stringList(detail.locations, 1, "locations.shape").map(
          canonicalResource,
        );
  return {
    locations,
    actions: detail.actions === undefined ? null : parseActions(detail.actions),
    models: detail.models === undefined ? null : parseModels(detail.models),
    budget: detail.budget === undefined ? null : parseBudget(detail.budget),
    lifetimeSeconds:
      detail.lifetime_seconds === undefined
        ? null
        : integer(
            detail.lifetime_seconds,
            1,
            LIMITS.maxLifetimeSeconds,
            "lifetime",
          ),
  };
}
