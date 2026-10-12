/** Optional provider-specific configuration; connector plans own OAuth choices. */
import { z } from "zod";
import metadata from "../../../../spec/connectors/self-hosted-config.json" with {
  type: "json",
};
import { type ConnectPlan, connectPlan } from "./connect-plan.js";

export const ConfigChoiceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    default: z.boolean(),
  })
  .strict();

const ConfigFieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    placeholder: z.string(),
    required: z.boolean(),
  })
  .strict();

const distinctNames = (values: { name: string }[]): boolean =>
  new Set(values.map((value) => value.name)).size === values.length;
const distinctStrings = (values: string[]): boolean =>
  new Set(values).size === values.length;
const scopeDefaults = z.array(z.string().min(1)).refine(distinctStrings);

const ProviderConfigSchema = z
  .object({
    fields: z.array(ConfigFieldSchema).refine(distinctNames).default([]),
    appScopeDefaults: scopeDefaults.optional(),
    userScopeDefaults: scopeDefaults.optional(),
    webhookResourceTypes: z
      .array(ConfigChoiceSchema)
      .refine(distinctNames)
      .default([]),
    sources: z.array(z.url().refine((value) => value.startsWith("https://"))),
  })
  .strict();

export const SelfHostedConfigMetadataSchema = z
  .object({
    version: z.literal(1),
    providers: z.record(z.string(), ProviderConfigSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [id, extras] of Object.entries(value.providers)) {
      const plan = connectPlan(id);
      if (!plan) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", id],
          message: "Unknown connector plan",
        });
        continue;
      }
      const names = new Set(oauthScopes(plan).map((scope) => scope.name));
      for (const field of ["appScopeDefaults", "userScopeDefaults"] as const) {
        for (const name of extras[field] ?? []) {
          if (!names.has(name))
            ctx.addIssue({
              code: "custom",
              path: ["providers", id, field],
              message: `Unknown OAuth scope: ${name}`,
            });
        }
      }
    }
  });

export type ConfigChoice = z.infer<typeof ConfigChoiceSchema>;
export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type SelfHostedConfig = {
  fields: ConfigField[];
  appScopes: ConfigChoice[];
  userScopes: ConfigChoice[];
  webhookResourceTypes: ConfigChoice[];
  docsUrl: string | null;
};

let parsed: z.infer<typeof SelfHostedConfigMetadataSchema> | undefined;

function oauthScopes(plan: ConnectPlan): ConfigChoice[] {
  const oauth = plan.methods.find(
    (method) => method.kind === "oauth" && method.preset,
  );
  return oauth?.kind === "oauth" ? (oauth.preset?.scopes ?? []) : [];
}

function choicesWithDefaults(
  choices: ConfigChoice[],
  defaults?: string[],
): ConfigChoice[] {
  return choices.map((choice) => ({
    ...choice,
    default: defaults ? defaults.includes(choice.name) : choice.default,
  }));
}

/** A self-hosted form needs no Vercel account, token, team or project. */
export function selfHostedConfig(
  plan: ConnectPlan | undefined,
): SelfHostedConfig | undefined {
  if (!plan || plan.refused) return undefined;
  parsed ??= SelfHostedConfigMetadataSchema.parse(metadata);
  const extras = parsed.providers[plan.id];
  const scopes = oauthScopes(plan);
  return {
    fields: (extras?.fields ?? []).map((field) => ({ ...field })),
    appScopes: choicesWithDefaults(scopes, extras?.appScopeDefaults),
    userScopes: extras?.userScopeDefaults
      ? choicesWithDefaults(scopes, extras.userScopeDefaults)
      : [],
    webhookResourceTypes: (extras?.webhookResourceTypes ?? []).map(
      (choice) => ({ ...choice }),
    ),
    docsUrl: plan.docsUrl,
  };
}

export function defaultSelections(choices: readonly ConfigChoice[]): string[] {
  return choices
    .filter((choice) => choice.default)
    .map((choice) => choice.name);
}
