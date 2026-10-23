/**
 * The social choices SIOP consent can offer: the configured identity
 * providers and active connections that can vouch for a person, and the
 * short-lived attempt that carries one choice across the hosted redirect.
 *
 * A connection is already authorized in this vault; an identity provider
 * still needs its hosted OAuth leg. Both end here as a `SiopSocialProof`;
 * the approval step rechecks the upstream session or the connection before
 * it mints the Self-Issued token.
 */

import {
  type Connection,
  type Provider,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { operatorUpstream } from "@opensesame/app-core/lib/federation-operator.js";
import type { TrustedUpstream } from "@opensesame/app-core/lib/federation.js";
import { providerUpstream } from "@opensesame/app-core/lib/providers.js";
import { signInMethods } from "@opensesame/app-core/lib/settings.js";
import { sessionStore } from "@opensesame/app-core/ports.js";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  readString,
} from "@opensesame/os-domain";
import { useEffect, useMemo, useState } from "react";
import { useFederatedProviders } from "../screens/unlock/use-federated-providers.js";

export type SiopSocialChoice = Readonly<{
  id: string;
  label: string;
  source: "identity" | "connection";
  providerId: string;
  /** The trusted upstream that completes an identity choice. */
  upstream?: TrustedUpstream;
  /** The session `upstreamId` expected when that redirect returns. */
  upstreamId?: string;
  /** The configured connection that stands as proof for a connection choice. */
  connectionId?: string;
  accountLabel?: string | null;
}>;

export type SiopSocialAttempt = Readonly<{
  id: string;
  source: SiopSocialChoice["source"];
  providerId: string;
  label: string;
  personId: string;
  at: number;
  upstreamId?: string;
  connectionId?: string;
}>;

const ATTEMPT_KEY = "opensesame:siop-social";
const ATTEMPT_LIFETIME_MS = 10 * 60_000;

const CONNECTION_SOCIAL_PROVIDERS = new Set([
  "auth0",
  "bitbucket",
  "codeberg",
  "discord",
  "dropbox",
  "github",
  "gitlab",
  "google",
  "microsoft",
  "microsoft-teams",
  "okta",
  "openrouter",
  "spotify",
  "twitch",
  "vercel",
]);

function uniqueChoices(
  choices: readonly SiopSocialChoice[],
): SiopSocialChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    const key = `${choice.source}:${choice.upstreamId ?? choice.connectionId ?? choice.providerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function useSiopSocialChoices(): readonly SiopSocialChoice[] {
  const catalog = useFederatedProviders();
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    let live = true;
    void listConnections()
      .then((rows) => {
        if (live) setConnections(rows);
      })
      .catch(() => {
        if (live) setConnections([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => {
    const providers = new Map(
      getBundledProviders().map((provider) => [provider.id, provider]),
    );
    const identity = catalog
      .filter((provider) => provider.id !== "mock")
      .map((provider): SiopSocialChoice => {
        const upstream = providerUpstream(provider);
        return {
          id: `identity:${provider.id}`,
          label: provider.label,
          source: "identity",
          providerId: provider.id,
          upstream,
          upstreamId: upstream.id,
        };
      });
    const operators = signInMethods()
      .providers.filter((provider) => provider.protocol !== "saml")
      .map((provider): SiopSocialChoice => {
        const upstream = operatorUpstream(provider);
        return {
          id: `identity:${upstream.id}`,
          label: provider.label,
          source: "identity",
          providerId: provider.providerId || provider.issuer,
          upstream,
          upstreamId: upstream.id,
        };
      });
    const configured = connections.flatMap((connection) => {
      if (connection.status !== "active") return [];
      if (!CONNECTION_SOCIAL_PROVIDERS.has(connection.providerId)) return [];
      const provider: Provider | undefined = providers.get(
        connection.providerId,
      );
      if (!provider) return [];
      return {
        id: `connection:${connection.connectionId}`,
        label: provider.displayName,
        source: "connection" as const,
        providerId: provider.id,
        connectionId: connection.connectionId,
        accountLabel: connection.accountLabel,
      };
    });
    return uniqueChoices([...identity, ...operators, ...configured]);
  }, [catalog, connections]);
}

export function saveSiopSocialAttempt(attempt: SiopSocialAttempt): void {
  sessionStore().setItem(ATTEMPT_KEY, JSON.stringify(attempt));
}

export function readSiopSocialAttempt(
  id: string | null,
): SiopSocialAttempt | null {
  if (!id) return null;
  const raw = sessionStore().getItem(ATTEMPT_KEY);
  if (!raw) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(parsed) ||
      parsed.id !== id ||
      (parsed.source !== "identity" && parsed.source !== "connection") ||
      !isString(parsed.providerId) ||
      !isString(parsed.label) ||
      !isString(parsed.personId) ||
      !isNumber(parsed.at) ||
      Date.now() - parsed.at > ATTEMPT_LIFETIME_MS
    )
      return null;
    return {
      id: parsed.id,
      source: parsed.source,
      providerId: parsed.providerId,
      label: parsed.label,
      personId: parsed.personId,
      at: parsed.at,
      upstreamId: readString(parsed.upstreamId),
      connectionId: readString(parsed.connectionId),
    };
  } catch {
    return null;
  }
}

export function clearSiopSocialAttempt(): void {
  sessionStore().removeItem(ATTEMPT_KEY);
}

/** The SIOP page again, carrying the attempt through the hosted redirect. */
export function siopSocialReturnTo(id: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("social", id);
  return `${url.pathname}${url.search}`;
}
