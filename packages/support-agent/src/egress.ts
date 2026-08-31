/**
 * The outbound boundary: the last code that touches a support request before
 * it reaches a model, local or remote.
 *
 * `sanitizeSupportRequest` deliberately *rebuilds* its result field by field
 * from primitives. It never spreads, clones or `JSON.parse(JSON.stringify(…))`
 * the input, because every one of those forwards whatever it is handed — an
 * element, a vault record, a getter that runs on read — and only pretends to
 * be a boundary. Rebuilding means an unexpected key has nowhere to go: it is
 * refused rather than sent.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  SUPPORT_LIMITS,
  type SupportCapabilityDescription,
  type SupportGoalDescription,
  type SupportMessage,
  type SupportMessageRole,
  type SupportPageContext,
  type SupportRequest,
  type SupportRouteDescription,
  type SupportStateFact,
  type SupportTargetDescription,
  type SupportTargetRole,
} from "./contract.js";

/**
 * Refusal to send. Distinct from the rest of `SupportError` so that a caller
 * catching this one knows nothing left the device.
 */
export class SupportEgressRefused extends Error {
  readonly code = "EGRESS_REFUSED";
  /** The offending field path. Never the offending value. */
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`support egress refused: ${field} ${reason}`);
    this.name = "SupportEgressRefused";
    this.field = field;
  }
}

function refuse(field: string, reason: string): never {
  throw new SupportEgressRefused(field, reason);
}

/**
 * Key fragments that must never appear in an outbound payload. Matched against
 * a key with case and separators stripped, so `private_key`, `Private-Key` and
 * `PRIVATEKEY` are one denial. Substring matching is intentional: a `userToken`
 * field is exactly as disqualifying as a `token` one.
 */
const DENIED_KEY_TERMS: readonly string[] = [
  "password",
  "secret",
  "token",
  "totp",
  "privatekey",
  "recoverycode",
  "cardnumber",
  "note",
  "items",
  "folders",
  "vault",
  "cookie",
  "authorization",
];

/**
 * Keys that only exist on a live browser object. Their presence means one
 * reached the boundary, whatever its prototype claims.
 */
const HOST_OBJECT_KEYS: readonly string[] = [
  "nodeType",
  "ownerDocument",
  "defaultView",
  "document",
  "location",
  "navigator",
  "postMessage",
  "window",
];

const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_NODES = 4096;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deniedKeyTerm(key: string): string | null {
  const normalized = normalizeKey(key);
  for (const term of DENIED_KEY_TERMS) {
    if (normalized.includes(term)) return term;
  }
  return null;
}

/**
 * A plain object or array with the default prototype. A class instance, a
 * `Date`, a `Map`, an `Error` and an `HTMLElement` all fail here, so the walk
 * below only ever recurses through data.
 */
function isPlainContainer(value: BoundaryValue): boolean {
  const tag = Object.prototype.toString.call(value);
  if (tag !== "[object Object]" && tag !== "[object Array]") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    prototype === Array.prototype
  );
}

type ScanBudget = { remaining: number };

function scanValue(
  value: BoundaryValue,
  field: string,
  depth: number,
  budget: ScanBudget,
  ancestors: Set<BoundaryValue>,
): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) refuse(field, "exceeds the egress scan budget");
  if (depth > MAX_SCAN_DEPTH) refuse(field, "nests deeper than the scan limit");
  if (isFunction(value)) refuse(field, "is a function");
  if (value === null || !isTypeofObject(value)) {
    if (
      value === null ||
      isString(value) ||
      isNumber(value) ||
      isBoolean(value)
    ) {
      return;
    }
    refuse(field, "is not a string, number, boolean or null");
  }
  if (ancestors.has(value)) refuse(field, "closes a reference cycle");

  for (const key of HOST_OBJECT_KEYS) {
    if (key in value) refuse(field, `carries the host-object key ${key}`);
  }
  if (!isPlainContainer(value)) refuse(field, "is not a plain object or array");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    refuse(field, "carries symbol-keyed properties");
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry === undefined) refuse(`${field}[${index}]`, "is an array hole");
      scanValue(entry, `${field}[${index}]`, depth + 1, budget, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  /* SAFETY: isPlainContainer already established a default-prototype object, so
     enumerating own descriptors here cannot reach an inherited accessor. */
  const record = value as JsonObject;
  for (const key of Object.getOwnPropertyNames(record)) {
    const path = `${field}.${key}`;
    const denied = deniedKeyTerm(key);
    if (denied !== null) refuse(path, `matches the denied key term ${denied}`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) refuse(path, "has no readable descriptor");
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      refuse(path, "is an accessor property");
    }
    const entry: BoundaryValue = descriptor.value;
    if (entry === undefined) continue;
    scanValue(entry, path, depth + 1, budget, ancestors);
  }
  ancestors.delete(value);
}

/**
 * Throw when a value carries anything that must not cross the boundary: a
 * function, a live browser object, an accessor that would run on read, a
 * reference cycle, or a key from the denylist.
 */
export function assertNoStructuralLeak(value: BoundaryValue): void {
  scanValue(value, "value", 0, { remaining: MAX_SCAN_NODES }, new Set());
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function requireObject(
  value: BoundaryValue | undefined,
  field: string,
): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    refuse(field, "is not an object");
  }
  return value;
}

function requireArray(
  value: BoundaryValue | undefined,
  field: string,
): readonly BoundaryValue[] {
  if (!Array.isArray(value)) refuse(field, "is not an array");
  return value;
}

function requireString(
  value: BoundaryValue | undefined,
  field: string,
): string {
  if (!isString(value)) refuse(field, "is not a string");
  return value;
}

function requireBoolean(
  value: BoundaryValue | undefined,
  field: string,
): boolean {
  if (!isBoolean(value)) refuse(field, "is not a boolean");
  return value;
}

/**
 * Identifiers are registry-authored, so an over-long one did not come from the
 * registry. Truncating it would forward a *different* identifier, which is
 * worse than refusing.
 */
const MAX_IDENTIFIER_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 240;

function requireIdentifier(
  value: BoundaryValue | undefined,
  field: string,
): string {
  const text = requireString(value, field);
  if (text.length === 0) refuse(field, "is an empty identifier");
  if (text.length > MAX_IDENTIFIER_CHARS) {
    refuse(field, "is an over-long identifier");
  }
  return text;
}

function requireExactKeys(
  record: JsonObject,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.getOwnPropertyNames(record);
  for (const key of actual) {
    if (!expected.includes(key)) {
      refuse(`${field}.${key}`, "is not part of the contract");
    }
  }
  for (const key of expected) {
    if (!actual.includes(key)) refuse(`${field}.${key}`, "is missing");
  }
}

const TARGET_ROLES: readonly SupportTargetRole[] = [
  "navigation",
  "action",
  "ceremony",
  "status",
  "filter",
  "surface",
];

function requireTargetRole(
  value: BoundaryValue | undefined,
  field: string,
): SupportTargetRole {
  const text = requireString(value, field);
  for (const role of TARGET_ROLES) {
    if (role === text) return role;
  }
  refuse(field, "is not a declared target role");
}

const MESSAGE_ROLES: readonly SupportMessageRole[] = ["user", "assistant"];

function requireMessageRole(
  value: BoundaryValue | undefined,
  field: string,
): SupportMessageRole {
  const text = requireString(value, field);
  for (const role of MESSAGE_ROLES) {
    if (role === text) return role;
  }
  refuse(field, "is not a declared message role");
}

const REQUEST_KEYS: readonly string[] = ["question", "history", "context"];
const MESSAGE_KEYS: readonly string[] = ["role", "text"];
const CONTEXT_KEYS: readonly string[] = [
  "version",
  "pageId",
  "route",
  "targets",
  "routes",
  "state",
  "capabilities",
  "goals",
];
const TARGET_KEYS: readonly string[] = ["id", "description", "role", "mounted"];
const ROUTE_KEYS: readonly string[] = ["id", "title"];
const STATE_KEYS: readonly string[] = ["id", "value"];
const CAPABILITY_KEYS: readonly string[] = ["id", "title", "available"];
const GOAL_KEYS: readonly string[] = ["id", "title"];

/** Keeps the most recent turns — the oldest are the ones an answer needs least. */
function sanitizeHistory(
  value: BoundaryValue | undefined,
): readonly SupportMessage[] {
  const list = requireArray(value, "request.history");
  const start = Math.max(0, list.length - SUPPORT_LIMITS.maxHistoryTurns);
  const out: SupportMessage[] = [];
  for (let index = start; index < list.length; index += 1) {
    const field = `request.history[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, MESSAGE_KEYS, field);
    out.push({
      role: requireMessageRole(record.role, `${field}.role`),
      text: clampText(
        requireString(record.text, `${field}.text`),
        SUPPORT_LIMITS.maxHistoryMessageChars,
      ),
    });
  }
  return out;
}

function sanitizeTargets(
  value: BoundaryValue | undefined,
): readonly SupportTargetDescription[] {
  const list = requireArray(value, "request.context.targets");
  const out: SupportTargetDescription[] = [];
  const count = Math.min(list.length, SUPPORT_LIMITS.maxTargets);
  for (let index = 0; index < count; index += 1) {
    const field = `request.context.targets[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, TARGET_KEYS, field);
    out.push({
      id: requireIdentifier(record.id, `${field}.id`),
      description: clampText(
        requireString(record.description, `${field}.description`),
        MAX_DESCRIPTION_CHARS,
      ),
      role: requireTargetRole(record.role, `${field}.role`),
      mounted: requireBoolean(record.mounted, `${field}.mounted`),
    });
  }
  return out;
}

function sanitizeRoutes(
  value: BoundaryValue | undefined,
): readonly SupportRouteDescription[] {
  const list = requireArray(value, "request.context.routes");
  const out: SupportRouteDescription[] = [];
  const count = Math.min(list.length, SUPPORT_LIMITS.maxRoutes);
  for (let index = 0; index < count; index += 1) {
    const field = `request.context.routes[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, ROUTE_KEYS, field);
    out.push({
      id: requireIdentifier(record.id, `${field}.id`),
      title: clampText(
        requireString(record.title, `${field}.title`),
        MAX_DESCRIPTION_CHARS,
      ),
    });
  }
  return out;
}

function sanitizeState(
  value: BoundaryValue | undefined,
): readonly SupportStateFact[] {
  const list = requireArray(value, "request.context.state");
  const out: SupportStateFact[] = [];
  const count = Math.min(list.length, SUPPORT_LIMITS.maxStateFacts);
  for (let index = 0; index < count; index += 1) {
    const field = `request.context.state[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, STATE_KEYS, field);
    out.push({
      id: requireIdentifier(record.id, `${field}.id`),
      value: requireBoolean(record.value, `${field}.value`),
    });
  }
  return out;
}

function sanitizeCapabilities(
  value: BoundaryValue | undefined,
): readonly SupportCapabilityDescription[] {
  const list = requireArray(value, "request.context.capabilities");
  const out: SupportCapabilityDescription[] = [];
  const count = Math.min(list.length, SUPPORT_LIMITS.maxCapabilities);
  for (let index = 0; index < count; index += 1) {
    const field = `request.context.capabilities[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, CAPABILITY_KEYS, field);
    out.push({
      id: requireIdentifier(record.id, `${field}.id`),
      title: clampText(
        requireString(record.title, `${field}.title`),
        MAX_DESCRIPTION_CHARS,
      ),
      available: requireBoolean(record.available, `${field}.available`),
    });
  }
  return out;
}

function sanitizeGoals(
  value: BoundaryValue | undefined,
): readonly SupportGoalDescription[] {
  const list = requireArray(value, "request.context.goals");
  const out: SupportGoalDescription[] = [];
  const count = Math.min(list.length, SUPPORT_LIMITS.maxGoals);
  for (let index = 0; index < count; index += 1) {
    const field = `request.context.goals[${index}]`;
    const record = requireObject(list[index], field);
    requireExactKeys(record, GOAL_KEYS, field);
    out.push({
      id: requireIdentifier(record.id, `${field}.id`),
      title: clampText(
        requireString(record.title, `${field}.title`),
        MAX_DESCRIPTION_CHARS,
      ),
    });
  }
  return out;
}

function sanitizeContext(value: BoundaryValue | undefined): SupportPageContext {
  const record = requireObject(value, "request.context");
  requireExactKeys(record, CONTEXT_KEYS, "request.context");
  if (record.version !== 1) {
    refuse("request.context.version", "is not the version this boundary knows");
  }
  return {
    version: 1,
    pageId: requireIdentifier(record.pageId, "request.context.pageId"),
    route: requireIdentifier(record.route, "request.context.route"),
    targets: sanitizeTargets(record.targets),
    routes: sanitizeRoutes(record.routes),
    state: sanitizeState(record.state),
    capabilities: sanitizeCapabilities(record.capabilities),
    goals: sanitizeGoals(record.goals),
  };
}

/**
 * Rebuild a request from primitives, or refuse.
 *
 * The declared parameter type is not evidence: a request assembled by UI code
 * can still carry an element, a getter or a vault record at runtime, which is
 * why every field below is re-read through a guard rather than copied over.
 */
export function sanitizeSupportRequest(
  request: SupportRequest,
): SupportRequest {
  // SAFETY: an egress argument is unvalidated runtime data whatever it was
  // declared as; BoundaryValue names that, and every field is re-read below.
  const raw: BoundaryValue = overlapCast(request);
  assertNoStructuralLeak(raw);
  const record = requireObject(raw, "request");
  requireExactKeys(record, REQUEST_KEYS, "request");
  return {
    question: clampText(
      requireString(record.question, "request.question"),
      SUPPORT_LIMITS.maxQuestionChars,
    ),
    history: sanitizeHistory(record.history),
    context: sanitizeContext(record.context),
  };
}

/**
 * Shown above any transport that leaves the device.
 *
 * It does not promise redaction. We can refuse structured secrets — this file
 * does — but a sentence a person types is prose, and no pattern match can
 * decide whether prose contains their password. Claiming otherwise would be
 * the dangerous part.
 */
export function redactionWarning(): string {
  return (
    "This question, and the names of the controls on this page, leave your device to be answered. " +
    "Do not paste a password, recovery code, one-time code, card number or private key into it: " +
    "nothing here can tell that a secret is hidden inside a sentence you wrote, so keeping one out is yours to do."
  );
}
