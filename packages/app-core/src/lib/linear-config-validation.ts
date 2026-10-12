/** Validate only Linear-supported methods, scopes and webhook settings. */
import type { DraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import { linearGrant } from "./linear-store.js";
import { selfHostedConfig } from "./self-hosted-config.js";
import {
  DraftSchema,
  OptionsSchema,
  type SelfHostedConnectorOptions,
} from "./self-hosted-connectors-schema.js";
function webhookProblems(
  state: DraftState,
  options: SelfHostedConnectorOptions,
): string[] {
  if (!options.webhookEnabled) return [];
  const problems: string[] = [];
  try {
    const url = new URL(options.webhookUrl ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error();
  } catch {
    problems.push(
      "Enter an HTTPS webhook delivery URL without credentials or a fragment",
    );
  }
  if (!options.webhookResourceTypes.length)
    problems.push("Select at least one webhook resource type");
  if (state.method === "oauth" && !options.appScopes.includes("admin"))
    problems.push("App Scopes must include admin to configure Linear webhooks");
  return problems;
}
function scopeProblems(options: SelfHostedConnectorOptions): string[] {
  const config = selfHostedConfig(connectPlan("linear"));
  const problems: string[] = [];
  for (const field of [
    "appScopes",
    "userScopes",
    "webhookResourceTypes",
  ] as const) {
    const known = new Set(config?.[field].map((choice) => choice.name));
    if (options[field].some((value) => !known.has(value)))
      problems.push(`Select supported Linear ${field}`);
  }
  return problems;
}
function methodProblems(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  id?: string,
): string[] {
  const problems: string[] = [];
  if (state.method !== "oauth" && state.method !== "api-key")
    problems.push("Select Linear OAuth or an API key");
  if (
    state.method === "oauth" &&
    !/^[A-Za-z0-9_-]{1,256}$/.test(state.oauth.clientId.trim())
  )
    problems.push("Enter the registered Linear OAuth client ID");
  if (
    state.method === "api-key" &&
    !state.key.trim() &&
    !(id && linearGrant(id, "app")?.kind === "api-key")
  )
    problems.push("Enter your Linear API key");
  if (
    state.method === "oauth" &&
    options.appScopes.length + options.userScopes.length === 0
  )
    problems.push("Select app or user permissions to authorize");
  return problems;
}
export function linearConnectorProblems(
  state: DraftState,
  options: SelfHostedConnectorOptions,
  id?: string,
): string[] {
  if (
    !DraftSchema.safeParse(state).success ||
    !OptionsSchema.safeParse(options).success
  )
    return ["Invalid Linear connector configuration"];
  return [
    ...(!state.name.trim() ? ["Enter a connector name"] : []),
    ...methodProblems(state, options, id),
    ...scopeProblems(options),
    ...webhookProblems(state, options),
  ];
}
