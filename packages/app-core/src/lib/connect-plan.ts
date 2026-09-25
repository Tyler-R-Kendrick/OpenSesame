/**
 * Connector plans (ADR 0146): for each service, the ways it can be connected
 * and everything known about each way — so a connector page opens already
 * filled in, and a person only supplies what is theirs (a client id, a
 * domain, a key).
 *
 * The plans are generated from `spec/connectors/` (see
 * `scripts/emit-connect-presets.mjs`); resolve a plan through this module and
 * keep no second list.
 */
import { z } from "zod";
import { CONNECT_PLAN_JSON } from "./connect-presets.generated.js";
import type { ProviderCategory } from "./connections.js";

/** An https URL, possibly naming `{placeholders}` a person fills in. */
const url = z.string().refine((value) => {
  try {
    return new URL(value.replace(/\{[a-z_]+\}/g, "x")).protocol === "https:";
  } catch {
    return false;
  }
}, "an https URL");

const TemplateParamSchema = z.object({
  name: z.string().regex(/^[a-z_]+$/),
  label: z.string(),
  placeholder: z.string(),
});

export const OauthPresetSchema = z.object({
  serverUrl: url,
  authorizationEndpoint: url,
  tokenEndpoint: url,
  revocationEndpoint: url.nullable(),
  userinfoEndpoint: url.nullable(),
  tokenAuth: z.enum(["client_secret_post", "client_secret_basic", "none"]),
  pkce: z.enum(["S256", "none", "required"]),
  authorizationParams: z.record(z.string(), z.string()),
  scopes: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      default: z.boolean(),
    }),
  ),
  refreshTokens: z.boolean(),
  registration: z.enum(["manual", "dcr", "cimd"]),
  consoleUrl: url.nullable(),
  docsUrl: url.nullable(),
  templateParams: z.array(TemplateParamSchema),
});

export const ApiKeyPresetSchema = z.object({
  keyUrl: url.nullable(),
  keyPrefix: z.string().nullable(),
  serviceUrls: z.array(url),
  instructions: z.string().max(4000),
  docsUrl: url.nullable(),
  templateParams: z.array(TemplateParamSchema),
});

const McpInfoSchema = z.discriminatedUnion("status", [
  z.object({ url, status: z.literal("no_metadata") }),
  z.object({
    url,
    status: z.literal("ok"),
    issuer: url.nullable(),
    authorizationEndpoint: url,
    tokenEndpoint: url,
    registration: z.enum(["manual", "dcr", "cimd"]),
    pkce: z.array(z.string()),
    scopes: z.array(z.string()),
  }),
]);

const MethodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("managed") }),
  z.object({ kind: z.literal("oauth"), preset: OauthPresetSchema.nullable() }),
  z.object({ kind: z.literal("mcp"), mcp: McpInfoSchema }),
  z.object({
    kind: z.literal("api-key"),
    urls: z.array(url),
    preset: ApiKeyPresetSchema.nullable(),
  }),
]);

const CATEGORIES = [
  "identity",
  "backup_recovery",
  "encryption",
  "password_managers",
  "agent_harnesses",
  "networking",
  "wallet",
  "cloud_secret_storage",
  "local_storage",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "testing",
  "certificates",
  "custom",
] as const satisfies readonly ProviderCategory[];

export const ConnectPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  name: z.string().min(1),
  docsUrl: url.nullable(),
  category: z.enum(CATEGORIES),
  /** Listed in Vercel Connect's service registry (preset configuration). */
  registry: z.boolean(),
  /** Payment rails OpenSesame never connects (ADR 0086 §6). */
  refused: z.boolean(),
  methods: z.array(MethodSchema),
});

export type OauthPreset = z.infer<typeof OauthPresetSchema>;
export type ApiKeyPreset = z.infer<typeof ApiKeyPresetSchema>;
export type McpInfo = z.infer<typeof McpInfoSchema>;
export type ConnectMethod = z.infer<typeof MethodSchema>;
export type ConnectMethodKind = ConnectMethod["kind"];
export type ConnectPlan = z.infer<typeof ConnectPlanSchema>;

const PlanKeySchema = ConnectPlanSchema.pick({ id: true, refused: true });

type PlanEntry = { refused: boolean; json: string; plan?: ConnectPlan };

let entries: ReadonlyMap<string, PlanEntry> | null = null;

/**
 * Plans are validated only when read: the index holds each plan's id and
 * refusal, so asking whether a service is known costs no schema pass over
 * every plan on the boot path.
 */
function index(): ReadonlyMap<string, PlanEntry> {
  entries ??= new Map(
    CONNECT_PLAN_JSON.map((json) => {
      const key = PlanKeySchema.parse(JSON.parse(json));
      return [key.id, { refused: key.refused, json }];
    }),
  );
  return entries;
}

function planOf(entry: PlanEntry): ConnectPlan {
  entry.plan ??= ConnectPlanSchema.parse(JSON.parse(entry.json));
  return entry.plan;
}

/** Every plan, registry order first. */
export function connectPlans(): ConnectPlan[] {
  return [...index().values()].map(planOf);
}

/** The plan for a service, or `undefined` when nothing is known about it. */
export function connectPlan(id: string): ConnectPlan | undefined {
  const entry = index().get(id);
  return entry ? planOf(entry) : undefined;
}

/** Whether a plan exists for a service, without validating it. */
export function hasConnectPlan(id: string): boolean {
  return index().has(id);
}

/** Whether a service is refused (ADR 0086 §6), without validating its plan. */
export function isRefusedPlan(id: string): boolean {
  return index().get(id)?.refused === true;
}

/** A plan can be connected when one of its methods needs nothing we lack. */
export function isConnectable(plan: ConnectPlan): boolean {
  return !plan.refused && plan.methods.length > 0;
}

/**
 * The method a page offers first: the one that asks the least of a person.
 * Vercel's own app, then an MCP server that registers its own client, then
 * OAuth with a preset, then an API key.
 */
export function preferredMethod(plan: ConnectPlan): ConnectMethod | undefined {
  const rank = (method: ConnectMethod): number => {
    if (method.kind === "managed") return 0;
    if (method.kind === "mcp")
      return method.mcp.status === "ok" && method.mcp.registration !== "manual"
        ? 1
        : 5;
    if (method.kind === "oauth") return method.preset ? 2 : 4;
    return 3;
  };
  return [...plan.methods].sort((a, b) => rank(a) - rank(b))[0];
}

/** The authorization-code settings a person reviews before creating. */
export function defaultScopes(preset: OauthPreset): string[] {
  return preset.scopes.filter((scope) => scope.default).map((s) => s.name);
}

/** `{domain}` placeholders filled from what the person typed. */
export function fillTemplate(
  value: string,
  params: Readonly<Record<string, string>>,
): string {
  return value.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const filled = params[name]?.trim();
    return filled
      ? filled.replace(/^https?:\/\//, "").replace(/\/+$/, "")
      : whole;
  });
}

/** True while a preset still names a placeholder nobody filled in. */
export function hasOpenTemplate(value: string): boolean {
  return /\{[a-z_]+\}/.test(value);
}
