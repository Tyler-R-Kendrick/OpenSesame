import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BindingScope,
  type JsonValue,
  type PeerIdentitySelector,
  type TransportResult,
  type TrustProfileRef,
  decodeBindingScope,
  decodePeerEvidenceView,
  decodeSelector,
  decodeServiceBindingSet,
  decodeTimestamp,
  decodeTransportCapabilities,
  decodeTransportStatusView,
  decodeTrustProfileRef,
  fail,
  isJsonObject,
  parseRfc3339,
  resolveServiceBinding,
  succeed,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  BindingPurposeSchema,
  BindingScopeSchema,
  PeerEvidenceViewSchema,
  PeerIdentitySelectorSchema,
  ServiceBindingSetSchema,
  TransportCapabilitiesSchema,
  TransportPolicySchema,
  TransportStatusViewSchema,
  TransportTimestampSchema,
  TrustProfileRefSchema,
} from "../transport-security.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, "..", "..", "fixtures", "transport-security");

interface Fixture {
  readonly name: string;
  readonly kind: string;
  readonly input: JsonValue;
  readonly expect: {
    readonly ok: boolean;
    readonly canonical?: JsonValue;
    readonly binding_id?: string;
    readonly error?: string;
  };
}

function load(): Fixture[] {
  const out: Fixture[] = [];
  for (const sub of ["valid", "invalid"]) {
    const dir = join(corpus, sub);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
      out.push({ name: `${sub}/${file}`, ...doc });
    }
  }
  return out;
}

const SCHEMAS = new Map<string, ZodTypeAny>(
  Object.entries({
    service_binding_set: ServiceBindingSetSchema,
    peer_identity_selector: PeerIdentitySelectorSchema,
    transport_policy: TransportPolicySchema,
    transport_capabilities: TransportCapabilitiesSchema,
    peer_evidence_view: PeerEvidenceViewSchema,
    transport_status_view: TransportStatusViewSchema,
    timestamp: TransportTimestampSchema,
  }),
);

type Decoder = (value: JsonValue | undefined) => TransportResult<JsonValue>;

/** Domain values are readonly; the corpus compares plain JSON. */
function toJson<T>(result: TransportResult<T>): TransportResult<JsonValue> {
  return result.ok ? succeed(JSON.parse(JSON.stringify(result.value))) : result;
}

const DECODERS = new Map<string, Decoder>(
  Object.entries({
    service_binding_set: (v) => toJson(decodeServiceBindingSet(v)),
    peer_identity_selector: (v) => toJson(decodeSelector("selector", v)),
    transport_policy: (v) => {
      const parsed = TransportPolicySchema.safeParse(v);
      return parsed.success ? succeed(parsed.data) : fail("policy");
    },
    transport_capabilities: (v) => toJson(decodeTransportCapabilities("c", v)),
    peer_evidence_view: (v) => toJson(decodePeerEvidenceView("v", v)),
    transport_status_view: (v) => toJson(decodeTransportStatusView(v)),
    timestamp: (v) => decodeTimestamp("t", v),
  }),
);

function field(input: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(input) ? input[key] : undefined;
}

/** Resolution through the zod schemas for the inputs, then os-domain's resolver. */
function resolveWithSchemas(input: JsonValue): TransportResult<string> {
  const set = ServiceBindingSetSchema.safeParse(field(input, "set"));
  const scope = BindingScopeSchema.safeParse(field(input, "scope"));
  const profile = TrustProfileRefSchema.safeParse(field(input, "profile"));
  const presented = PeerIdentitySelectorSchema.array().safeParse(
    field(input, "presented"),
  );
  const purpose = BindingPurposeSchema.safeParse(field(input, "purpose"));
  const nowRaw = field(input, "now");
  const now =
    nowRaw === undefined || nowRaw === null
      ? null
      : parseRfc3339(String(nowRaw));
  if (
    !(
      set.success &&
      scope.success &&
      profile.success &&
      presented.success &&
      purpose.success
    ) ||
    now === null
  ) {
    return fail("resolution inputs");
  }
  const resolved = resolveServiceBinding(
    set.data,
    scope.data,
    profile.data,
    presented.data,
    purpose.data,
    now,
  );
  return resolved.ok ? succeed(resolved.value.id) : resolved;
}

/** The same resolution through os-domain's hand-written decoders. */
function resolveWithDecoders(input: JsonValue): TransportResult<string> {
  const set = decodeServiceBindingSet(field(input, "set"));
  const scope = decodeBindingScope("scope", field(input, "scope"));
  const profile = decodeTrustProfileRef("profile", field(input, "profile"));
  const presentedRaw = field(input, "presented");
  const purpose = BindingPurposeSchema.safeParse(field(input, "purpose"));
  const nowRaw = field(input, "now");
  const now =
    nowRaw === undefined || nowRaw === null
      ? null
      : parseRfc3339(String(nowRaw));
  if (!set.ok) return set;
  if (!scope.ok) return scope;
  if (!profile.ok) return profile;
  if (!Array.isArray(presentedRaw) || !purpose.success || now === null)
    return fail("resolution inputs");
  const presented: PeerIdentitySelector[] = [];
  for (const raw of presentedRaw) {
    const selector = decodeSelector("presented", raw);
    if (!selector.ok) return selector;
    presented.push(selector.value);
  }
  const typedScope: BindingScope = scope.value;
  const typedProfile: TrustProfileRef = profile.value;
  const resolved = resolveServiceBinding(
    set.value,
    typedScope,
    typedProfile,
    presented,
    purpose.data,
    now,
  );
  return resolved.ok ? succeed(resolved.value.id) : resolved;
}

function viaSchema(fixture: Fixture): TransportResult<JsonValue> {
  if (fixture.kind === "binding_resolution")
    return resolveWithSchemas(fixture.input);
  const schema = SCHEMAS.get(fixture.kind);
  if (!schema) throw new Error(`unknown fixture kind ${fixture.kind}`);
  const parsed = schema.safeParse(fixture.input);
  return parsed.success
    ? succeed(JSON.parse(JSON.stringify(parsed.data)))
    : fail(parsed.error.message);
}

function viaDecoder(fixture: Fixture): TransportResult<JsonValue> {
  if (fixture.kind === "binding_resolution")
    return resolveWithDecoders(fixture.input);
  const decoder = DECODERS.get(fixture.kind);
  if (!decoder) throw new Error(`unknown fixture kind ${fixture.kind}`);
  return decoder(fixture.input);
}

describe("shared transport-security corpus (Rust ↔ zod ↔ os-domain)", () => {
  const fixtures = load();

  it("has at least thirty fixtures across every kind", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    const kinds = new Set(fixtures.map((f) => f.kind));
    for (const kind of [...SCHEMAS.keys(), "binding_resolution"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} (${fixture.kind})`, () => {
      const wanted =
        fixture.kind === "binding_resolution"
          ? fixture.expect.binding_id
          : fixture.expect.canonical;
      for (const [route, outcome] of [
        ["zod", viaSchema(fixture)],
        ["os-domain", viaDecoder(fixture)],
      ] as const) {
        if (fixture.expect.ok) {
          expect(
            outcome.ok,
            `${route}: ${outcome.ok ? "" : outcome.error.detail}`,
          ).toBe(true);
          if (outcome.ok) expect(outcome.value, route).toEqual(wanted);
          expect(fixture.name.startsWith("valid/")).toBe(true);
        } else {
          expect(outcome.ok, `${route}: expected ${fixture.expect.error}`).toBe(
            false,
          );
          if (!outcome.ok)
            expect(outcome.error.code, route).toBe(fixture.expect.error);
          expect(fixture.name.startsWith("invalid/")).toBe(true);
        }
      }
    });
  }
});
