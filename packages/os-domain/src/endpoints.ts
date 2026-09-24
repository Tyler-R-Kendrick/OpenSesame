/**
 * The services a target talks to (`spec/config/endpoints.json`, ADR 0139).
 * Every target resolves an address the same way — the variable, then its
 * aliases in order, then the default — and no code outside this module and
 * its Rust twin (`opensesame_host_core::endpoints`) names an alias.
 */
import { ENDPOINTS_JSON } from "./endpoints.generated.js";

export type EndpointId = "host" | "identity" | "daemon";

export type EndpointVariable = {
  readonly env: string;
  readonly aliases: readonly string[];
  readonly default: string;
};

export type Endpoint = EndpointVariable & {
  readonly title: string;
  readonly listen: EndpointVariable;
  readonly pagesRuntimeKey: string;
  readonly viteKey: string;
  readonly setting: string;
  readonly loopbackOnly: boolean;
};

export const ENDPOINTS: Readonly<Record<EndpointId, Endpoint>> =
  /* @__PURE__ */ JSON.parse(ENDPOINTS_JSON);

export type Environment = Readonly<Record<string, string | undefined>>;

/** Every name a variable is read under, most specific first. */
export function variableNames(variable: EndpointVariable): readonly string[] {
  return [variable.env, ...variable.aliases];
}

function configured(
  variable: EndpointVariable,
  env: Environment,
): string | undefined {
  for (const name of variableNames(variable)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveVariable(variable: EndpointVariable, env: Environment): string {
  return configured(variable, env) ?? variable.default;
}

/** The address of `id` set in `env` under any of its names, if any. */
export function configuredEndpoint(
  id: EndpointId,
  env: Environment,
): string | undefined {
  return configured(ENDPOINTS[id], env);
}

/** The address of `id` in `env` (usually `process.env`). */
export function endpointAddress(id: EndpointId, env: Environment): string {
  return resolveVariable(ENDPOINTS[id], env);
}

/** What the server for `id` binds, from `env`. */
export function endpointListen(id: EndpointId, env: Environment): string {
  return resolveVariable(ENDPOINTS[id].listen, env);
}
