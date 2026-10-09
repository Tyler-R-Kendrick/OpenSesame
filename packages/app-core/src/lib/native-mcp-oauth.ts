/** Public MCP OAuth protocol only. The coordinator owns sealing, callback claims and cleanup. */
import {
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpOAuthAction } from "./native-mcp-oauth-errors.js";
import { nativeMcpOAuthFetch } from "./native-mcp-oauth-http.js";
import {
  type NativeMcpAuthorizationMetadata,
  nativeMcpPublicMetadata,
} from "./native-mcp-oauth-metadata.js";
import {
  NativeMcpAuthError,
  type NativeMcpOAuthTarget,
  validateNativeMcpOAuthTarget,
} from "./native-mcp-oauth-target.js";

import {
  type NativeMcpRegisteredClient,
  NativeMcpRegistrationReceiptSchema,
} from "./native-mcp-registration-receipt.js";

import {
  type NativeMcpIssuedTokens,
  captureNativeMcpTokenReply,
} from "./native-mcp-token-receipt.js";

type RegistrationCapture = { value: NativeMcpRegisteredClient | null };

export type NativeMcpOAuthPorts = {
  fetch: typeof fetch;
  /** Captured lease transport, used only after the coordinator sealed a mutation intent. */
  settleCredentialMutation?: typeof fetch;
  signal: AbortSignal;
  assertCurrent: () => void;
};

function assertPublicClient(
  target: NativeMcpOAuthTarget,
  client: NativeMcpRegisteredClient,
): void {
  if (
    !client.client_id ||
    client.client_secret ||
    client.issuer !== target.binding.issuer
  )
    throw new NativeMcpAuthError("public-client");
  if (
    "token_endpoint_auth_method" in client &&
    client.token_endpoint_auth_method !== undefined &&
    client.token_endpoint_auth_method !== "none"
  )
    throw new NativeMcpAuthError("public-client");
}

/** Registration/tokens are private return values for the sealed coordinator, never UI results. */
export class NativeMcpPublicOAuth {
  private readonly target: NativeMcpOAuthTarget;
  private readonly fetcher: typeof fetch;

  constructor(
    target: NativeMcpOAuthTarget,
    private readonly ports: NativeMcpOAuthPorts,
  ) {
    this.target = structuredClone(target);
    validateNativeMcpOAuthTarget(this.target);
    this.fetcher = nativeMcpOAuthFetch(
      this.target,
      ports.fetch,
      ports.signal,
      ports.assertCurrent,
      ports.settleCredentialMutation,
    );
  }

  private async metadata(): Promise<NativeMcpAuthorizationMetadata> {
    this.ports.assertCurrent();
    return mcpOAuthAction(() =>
      nativeMcpPublicMetadata(this.target, this.fetcher),
    );
  }

  /** Retain every DCR result before deciding whether to use or compensate it. */
  async register(
    retain: (client: NativeMcpRegisteredClient) => Promise<void>,
  ): Promise<NativeMcpRegisteredClient> {
    const metadata = await this.metadata();
    let client: NativeMcpRegisteredClient;
    if (this.target.registration === "dcr") {
      const receipt: RegistrationCapture = {
        value: null,
      };
      const registrationFetch: typeof fetch = async (input, init) => {
        const response = await this.fetcher(input, init);
        if (response.ok) {
          const parsed = NativeMcpRegistrationReceiptSchema.safeParse(
            await response.clone().json(),
          );
          if (parsed.success)
            receipt.value = {
              ...parsed.data,
              issuer: this.target.binding.issuer ?? undefined,
            };
        }
        return response;
      };
      try {
        const registered = await mcpOAuthAction(() =>
          registerClient(this.target.binding.issuer ?? "", {
            metadata,
            clientMetadata: {
              client_name: "OpenSesame",
              redirect_uris: [this.target.redirectUri],
              grant_types: metadata.grant_types_supported?.includes(
                "refresh_token",
              )
                ? ["authorization_code", "refresh_token"]
                : ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            scope: this.target.scopes.join(" "),
            fetchFn: registrationFetch,
          }),
        );
        client = {
          ...registered,
          ...receipt.value,
          issuer: this.target.binding.issuer ?? undefined,
        };
      } catch (error) {
        if (receipt.value) await retain(receipt.value);
        throw error;
      }
    } else {
      client = {
        client_id: this.target.clientMetadataUrl ?? this.target.clientId ?? "",
        issuer: this.target.binding.issuer ?? undefined,
      };
    }
    await retain(client);
    this.ports.assertCurrent();
    assertPublicClient(this.target, client);
    return client;
  }

  /** Caller seals state + this verifier atomically before navigating to authorizationUrl. */
  async consent(
    client: NativeMcpRegisteredClient,
    state: string,
  ): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
    assertPublicClient(this.target, client);
    if (!/^[a-zA-Z0-9_-]{43,512}$/.test(state))
      throw new NativeMcpAuthError("pending");
    const metadata = await this.metadata();
    return mcpOAuthAction(() =>
      startAuthorization(this.target.binding.issuer ?? "", {
        metadata,
        clientInformation: client,
        redirectUrl: this.target.redirectUri,
        scope: this.target.scopes.join(" "),
        state,
        resource: this.target.binding.resource,
      }),
    );
  }

  /** Called only after the coordinator has claimed the exact bound, expiring pending state. */
  async exchange(
    client: NativeMcpRegisteredClient,
    code: string,
    verifier: string,
  ): Promise<NativeMcpIssuedTokens> {
    assertPublicClient(this.target, client);
    if (!code || !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier))
      throw new NativeMcpAuthError("pending");
    const metadata = await this.metadata();
    return captureNativeMcpTokenReply(
      (fetchFn) =>
        mcpOAuthAction(() =>
          exchangeAuthorization(this.target.binding.issuer ?? "", {
            metadata,
            clientInformation: client,
            authorizationCode: code,
            codeVerifier: verifier,
            redirectUri: this.target.redirectUri,
            resource: this.target.binding.resource,
            fetchFn,
          }),
        ),
      this.fetcher,
      this.target.binding.issuer ?? "",
    );
  }

  /** Caller journals and seals each rotation before using it or performing further cleanup. */
  async refresh(
    client: NativeMcpRegisteredClient,
    token: string,
  ): Promise<NativeMcpIssuedTokens> {
    assertPublicClient(this.target, client);
    const metadata = await this.metadata();
    return captureNativeMcpTokenReply(
      (fetchFn) =>
        mcpOAuthAction(() =>
          refreshAuthorization(this.target.binding.issuer ?? "", {
            metadata,
            clientInformation: client,
            refreshToken: token,
            resource: this.target.binding.resource,
            fetchFn,
          }),
        ),
      this.fetcher,
      this.target.binding.issuer ?? "",
    );
  }

  /** RFC7009 public-client revocation; no confidential credential is sent from the browser. */
  async revoke(
    client: NativeMcpRegisteredClient,
    token: string,
    hint: "access_token" | "refresh_token",
  ): Promise<void> {
    assertPublicClient(this.target, client);
    const endpoint = this.target.metadata.revocationEndpoint;
    if (!endpoint) throw new NativeMcpAuthError("public-client");
    const response = await this.fetcher(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: client.client_id,
      }),
    });
    if (!response.ok) throw new NativeMcpAuthError("authorization");
  }
}
