/**
 * The page's side of the broker's ports (ADR 0188 §6).
 *
 * The catalog says which providers are model providers, how each is spoken to
 * and where; the saved connections say whether a credential stands behind a
 * provider. Both come in by function, so this file imports no native store and
 * the capability that owns the credentials stays the only one that reads them.
 */
import { modelApiOf } from "../ai-model-provider.js";
import { catalogProviders } from "../connector-catalog.js";
import { notifyModelKeys } from "./active.js";
import { systemClockPorts } from "./broker.js";
import { canonicalResource } from "./resource.js";
import type {
  BrokerPorts,
  ConnectionFacts,
  ModelKeyEvent,
  ProviderTarget,
} from "./types.js";

const KEYED_PROTOCOLS = [
  "openai_chat",
  "anthropic_messages",
  "gemini_generate_content",
] as const;

type Keyed = (typeof KEYED_PROTOCOLS)[number];

function isKeyed(protocol: string): protocol is Keyed {
  return KEYED_PROTOCOLS.some((keyed) => keyed === protocol);
}

function canonicalBase(baseUrl: string): string | null {
  try {
    return canonicalResource(baseUrl);
  } catch {
    return null;
  }
}

let targets: ReadonlyMap<string, ProviderTarget> | null = null;

/**
 * Every catalog provider a key can be for, by canonical base URL. A row whose
 * endpoint is the person's own, or whose protocol has no inspected routes
 * (`rest_json`), has no entry: a key for it would be a key nobody could narrow.
 */
function catalogTargets(): ReadonlyMap<string, ProviderTarget> {
  if (targets) return targets;
  const found = new Map<string, ProviderTarget>();
  for (const provider of catalogProviders()) {
    const api = modelApiOf(provider.id);
    if (!api?.baseUrl || !isKeyed(api.protocol)) continue;
    const baseUrl = canonicalBase(api.baseUrl);
    // Two rows on one host would make a resource ambiguous; the first stays.
    if (baseUrl === null || found.has(baseUrl)) continue;
    found.set(baseUrl, {
      providerId: provider.id,
      protocol: api.protocol,
      baseUrl,
    });
  }
  targets = found;
  return found;
}

/** Which provider a resource indicator names, or `null` for a host the catalog does not know. */
export function modelTargetForResource(
  resource: string,
): ProviderTarget | null {
  let canonical: string;
  try {
    canonical = canonicalResource(resource);
  } catch {
    return null;
  }
  return catalogTargets().get(canonical) ?? null;
}

/** The provider rows a person can mint a key for, in catalog order. */
export function keyedModelProviders(): readonly ProviderTarget[] {
  return [...catalogTargets().values()];
}

export type PageModelKeyDeps = Readonly<{
  /** The saved connection's facts, or `null` when none by that id exists. */
  connection: (connectionId: string) => ConnectionFacts | null;
  /** Where events go; the broker emits no token, so a sink may persist them. */
  audit?: (event: ModelKeyEvent) => void;
}>;

export function pageModelKeyPorts(deps: PageModelKeyDeps): BrokerPorts {
  return {
    ...systemClockPorts,
    providerForResource: modelTargetForResource,
    connection: deps.connection,
    audit: (event) => {
      try {
        deps.audit?.(event);
      } finally {
        notifyModelKeys();
      }
    },
  };
}

/** For tests: forget the cached target table. */
export function resetModelTargets(): void {
  targets = null;
}
