/**
 * Boat sandbox provider: allocates a cloud sandbox with no
 * pre-provisioned account, runs the relay agent inside it, and drives
 * the browser over the authenticated relay. With no API key, the
 * provider registers via auth.md; Boat's human gates (claim ceremony,
 * billing checkout) surface as `SandboxClaimRequiredError`, and a later
 * allocation resumes the flow. Secrets cross only per fill over the
 * relay — never through Boat's command history — and sandboxes are
 * created `noEnv`, monitoring off, snapshots off, deleted on close.
 * Registration, billing and cleanup are handled through the provider API.
 */

import { randomUUID } from "node:crypto";
import { BOAT_AGENT_ENV, resolveBoatAgentCommand } from "./boat-agent.js";
import {
  BoatAgentAuth,
  type BoatAuthOptions,
  BoatClaimInvalidError,
  type BoatClaimMaterials,
  BoatClaimPendingError,
  type BoatTokenGrant,
} from "./boat-auth.js";
import {
  BoatApiError,
  BoatClient,
  type BoatClientOptions,
} from "./boat-client.js";
import { boatHostedRelay, boatOrigin } from "./boat-endpoints.js";
import type {
  BoatProviderOptions,
  BoatProviderState,
} from "./boat-provider-options.js";
export type {
  BoatProviderOptions,
  BoatProviderState,
} from "./boat-provider-options.js";
import { waitBoatReady, waitBoatRelay } from "./boat-readiness.js";
import {
  isBoatClaimUsable,
  requireBoatClaim,
  resolveBoatRegistration,
  snapshotBoatRegistration,
} from "./boat-registration-state.js";
import { closeBoatRelay, connectBoatRelay } from "./boat-relay.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  SandboxClaimRequiredError,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

const RELAY_PORT = 8787;

export class BoatSandboxProvider implements SandboxProvider {
  readonly id = "boat" as const;

  private accessToken: string | undefined;
  private pendingAccessToken: string | undefined;
  private identityAssertion: string | undefined;
  private claimToken: string | undefined;
  private claimMaterials: BoatClaimMaterials | undefined;
  private claimIssuedAt: number | undefined;

  constructor(private readonly options: BoatProviderOptions = {}) {
    if (
      options.relayCloseTimeoutMs !== undefined &&
      (!Number.isInteger(options.relayCloseTimeoutMs) ||
        options.relayCloseTimeoutMs < 1 ||
        options.relayCloseTimeoutMs > 30_000)
    )
      throw new Error("boat: invalid relay close timeout");
    this.accessToken =
      options.apiToken ??
      process.env.BOAT_API_KEY ??
      process.env.BOAT_API_TOKEN;
    const registration = resolveBoatRegistration(options);
    this.claimToken = registration.claimToken;
    this.identityAssertion = registration.identityAssertion;
    this.claimMaterials = registration.claimMaterials;
    this.claimIssuedAt = registration.claimIssuedAt;
  }

  /** Registration state as it now stands, for hosts to protect when persisted. */
  registrationState(): BoatProviderState {
    return snapshotBoatRegistration(
      this.claimToken,
      this.identityAssertion,
      this.claimMaterials,
      this.claimIssuedAt,
    );
  }

  private stateDirty = false;

  hasUnpersistedState(): boolean {
    return this.stateDirty;
  }

  private async persistState(): Promise<void> {
    await this.options.onStateChange?.(this.registrationState());
    this.stateDirty = false;
  }

  private async adoptClaim(claim: BoatClaimMaterials): Promise<void> {
    this.claimToken = claim.claimToken;
    this.claimMaterials = claim;
    this.claimIssuedAt = Date.now();
    this.stateDirty = true;
    await this.persistState();
  }

  private get origin(): string {
    return boatOrigin(this.options.origin ?? "https://boat.dev");
  }

  private get claimEmail(): string | undefined {
    return this.options.claimEmail ?? process.env.BOAT_CLAIM_EMAIL;
  }

  private client(): BoatClient {
    if (this.options.client) return this.options.client;
    const clientOptions: BoatClientOptions = { origin: this.origin };
    if (this.options.fetchImpl)
      clientOptions.fetchImpl = this.options.fetchImpl;
    return new BoatClient(clientOptions);
  }

  private auth(): BoatAgentAuth {
    if (this.options.auth) return this.options.auth;
    const authOptions: BoatAuthOptions = { origin: this.origin };
    if (this.options.fetchImpl) authOptions.fetchImpl = this.options.fetchImpl;
    return new BoatAgentAuth(authOptions);
  }

  private async adoptGrant(
    grant: BoatTokenGrant,
    consumedClaim = false,
  ): Promise<string> {
    if (grant.identityAssertion) {
      this.identityAssertion = grant.identityAssertion;
      if (consumedClaim) {
        this.claimToken = undefined;
        this.claimMaterials = undefined;
        this.claimIssuedAt = undefined;
      }
      this.pendingAccessToken = grant.accessToken;
      this.stateDirty = true;
      try {
        await this.persistState();
      } catch {
        throw new Error(
          "boat: rotated identity could not be persisted and may be lost if the process exits",
        );
      }
    }
    this.accessToken = grant.accessToken;
    this.pendingAccessToken = undefined;
    return grant.accessToken;
  }

  private async resumeClaim(
    auth: BoatAgentAuth,
    token: string,
  ): Promise<string> {
    try {
      return await this.adoptGrant(await auth.pollClaim(token), true);
    } catch (error) {
      if (error instanceof BoatClaimInvalidError && this.identityAssertion)
        return this.adoptGrant(
          await auth.exchangeAssertion(this.identityAssertion),
          true,
        );
      if (!(error instanceof BoatClaimPendingError)) throw error;
      // An anonymous registration also yields an assertion. A pending
      // claim does not invalidate that assertion or require a new agent.
      if (this.identityAssertion)
        return this.adoptGrant(
          await auth.exchangeAssertion(this.identityAssertion),
        );
      const email = this.claimEmail;
      if (
        email &&
        (!this.claimMaterials ||
          !isBoatClaimUsable(
            this.claimMaterials,
            this.claimToken,
            this.claimIssuedAt,
          ))
      )
        await this.adoptClaim(await auth.requestClaim(token, email));
      requireBoatClaim(
        this.claimMaterials,
        this.claimToken,
        this.claimIssuedAt,
        this.origin,
      );
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.stateDirty) {
      await this.persistState();
      if (this.pendingAccessToken) {
        this.accessToken = this.pendingAccessToken;
        this.pendingAccessToken = undefined;
      }
    }
    if (this.accessToken) return this.accessToken;
    const auth = this.auth();
    if (this.claimToken) return this.resumeClaim(auth, this.claimToken);
    if (this.identityAssertion)
      return this.adoptGrant(
        await auth.exchangeAssertion(this.identityAssertion),
      );
    const registration = await auth.register(this.claimEmail);
    this.claimToken = registration.claimToken;
    if (registration.identityAssertion)
      this.identityAssertion = registration.identityAssertion;
    // Persist before any claim is surfaced: the process ends with the
    // human gate, and the next one must resume the same registration.
    if (registration.claim) {
      this.claimMaterials = registration.claim;
      this.claimIssuedAt = Date.now();
    }
    this.stateDirty = true;
    await this.persistState();
    if (!registration.identityAssertion)
      requireBoatClaim(
        this.claimMaterials,
        this.claimToken,
        this.claimIssuedAt,
        this.origin,
      );
    return this.adoptGrant(
      await auth.exchangeAssertion(registration.identityAssertion),
    );
  }

  /** Handle the human gates Boat puts in front of sandbox creation. */
  private async surfaceGate(
    error: BoatApiError,
    token: string,
  ): Promise<never> {
    if (error.code === "billing_required") {
      const url = await this.client().createCheckout(token);
      throw new SandboxClaimRequiredError({ verificationUri: url });
    }
    // claim_required: (re)start the ceremony so the person gets a
    // fresh code, then surface it through the intervention channel.
    const email = this.claimEmail;
    if (email && this.claimToken)
      await this.adoptClaim(
        await this.auth().requestClaim(this.claimToken, email),
      );
    requireBoatClaim(
      this.claimMaterials,
      this.claimToken,
      this.claimIssuedAt,
      this.origin,
    );
  }

  private async createSandbox(
    token: string,
    input: Parameters<BoatClient["createSandbox"]>[1],
    retriedAfterClaim = false,
  ): Promise<string> {
    try {
      const sandbox = await this.client().createSandbox(token, input);
      return sandbox.id;
    } catch (error) {
      if (!(error instanceof BoatApiError)) throw error;
      if (error.code === "billing_required")
        return this.surfaceGate(error, token);
      if (error.code !== "claim_required") throw error;
      // The cached token may be pre-claim while the person has since
      // finished the ceremony: poll once and retry with the live token
      // instead of handing out another code.
      if (this.claimToken && !retriedAfterClaim) {
        try {
          const liveToken = await this.adoptGrant(
            await this.auth().pollClaim(this.claimToken),
            true,
          );
          return this.createSandbox(liveToken, input, true);
        } catch (pollError) {
          if (!(pollError instanceof BoatClaimPendingError)) throw pollError;
        }
      }
      return this.surfaceGate(error, token);
    }
  }

  /** Resume an accepted deletion after BoatDeletionPendingError. */
  async waitForDeletion(sandboxId: string, operationId: string): Promise<void> {
    const token = await this.ensureAccessToken();
    await this.client().waitForDeletion(token, sandboxId, operationId);
  }

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const { command: agentCommand, bootstrapped } = resolveBoatAgentCommand(
      this.options,
    );
    // Cloning and installing on first boot takes minutes, not seconds.
    const relayTimeoutMs =
      this.options.agentReadyTimeoutMs ?? (bootstrapped ? 900_000 : 60_000);
    const { url, allowedDomains } = allowedDomainsFor(request);
    const token = await this.ensureAccessToken();
    const client = this.client();
    const relayToken = randomUUID();
    const createInput: Parameters<BoatClient["createSandbox"]>[1] = {
      labels: { opensesame: "password-reset" },
      env: {
        [BOAT_AGENT_ENV.token]: relayToken,
        [BOAT_AGENT_ENV.port]: String(RELAY_PORT),
        [BOAT_AGENT_ENV.origin]: url.origin,
        [BOAT_AGENT_ENV.extraAllowedDomains]: allowedDomains
          .filter((domain) => domain !== url.hostname)
          .join(","),
      },
    };
    const fromSnapshot =
      this.options.fromSnapshot ?? process.env.BOAT_SANDBOX_SNAPSHOT;
    if (fromSnapshot) createInput.from = fromSnapshot;
    const sandboxId = await this.createSandbox(token, createInput);
    // The claim flow may have rotated the token during creation.
    const liveToken = this.accessToken ?? token;
    try {
      const sandboxUrl = await waitBoatReady(
        () => this.client(),
        this.options,
        liveToken,
        sandboxId,
      );
      await client.startDetachedCommand(liveToken, sandboxId, agentCommand);
      const hostedUrl = await client.hostPort(liveToken, sandboxId, RELAY_PORT);
      const relay = boatHostedRelay(
        hostedUrl,
        sandboxUrl,
        this.origin,
        RELAY_PORT,
      );
      await waitBoatRelay(
        { ...this.options, agentReadyTimeoutMs: relayTimeoutMs },
        relay.url,
        relay.cookie,
      );
      const connection = await connectBoatRelay(
        relay.url,
        relayToken,
        relay.cookie,
      );
      const browser = connection.browser;
      return {
        provider: this.id,
        session: sandboxId,
        browser,
        allowedDomains,
        close: async () => {
          await closeBoatRelay(
            connection,
            this.options.relayCloseTimeoutMs ?? 5_000,
          );
          if (this.options.keepSandbox)
            await client.stopSandbox(liveToken, sandboxId);
          else await client.deleteSandbox(liveToken, sandboxId);
        },
      };
    } catch (error) {
      try {
        await client.deleteSandbox(liveToken, sandboxId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "boat: allocation failed and sandbox cleanup is not confirmed",
        );
      }
      throw error;
    }
  }
}
