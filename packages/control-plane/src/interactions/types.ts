import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject, JsonValue } from "@opensesame/os-domain";
/** Subset of the oidc-provider interaction details the interaction UI reads. */
export interface InteractionPrompt {
  name: "login" | "consent" | string;
  details?: {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    missingResourceScopes?: Record<string, string[]>;
  };
}

export interface InteractionDetails {
  uid: string;
  prompt: InteractionPrompt;
  params: {
    client_id?: string;
    scope?: string;
    redirect_uri?: string;
    [key: string]: JsonValue | undefined;
  };
  grantId?: string;
  session?: {
    accountId?: string;
    [key: string]: JsonValue | undefined;
  };
}

export interface GrantHandle {
  addOIDCScope(scope: string): void;
  addOIDCClaims(claims: string[]): void;
  addResourceScope(indicator: string, scope: string): void;
  save(): Promise<string>;
}

/**
 * Structural subset of the panva `Provider` used here, so the handlers do
 * not fight oidc-provider's generics. `interactionResult` performs the
 * session/grant bookkeeping of `interactionFinished` but returns the
 * resume URL instead of writing the raw response — the Hono handler owns
 * the redirect.
 */
export type ProviderInteractions = {
  Grant: {
    find(id: string): Promise<GrantHandle | undefined>;
    new (args: { accountId: string; clientId: string }): GrantHandle;
  };
  interactionDetails(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<InteractionDetails>;
  interactionResult(
    req: IncomingMessage,
    res: ServerResponse,
    result: JsonObject,
    opts?: { mergeWithLastSubmission?: boolean },
  ): Promise<string>;
};
