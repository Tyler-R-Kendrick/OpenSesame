/**
 * Boat sandbox provider: allocates a cloud sandbox with no
 * pre-provisioned account, runs the relay agent inside it, and drives
 * the browser over the authenticated relay.
 *
 * Zero-provision path (auth.md): with no API key configured, the
 * provider registers this agent with Boat, and when Boat requires a
 * person — the claim ceremony, then billing checkout — it throws
 * `SandboxClaimRequiredError` carrying only the link/code the person
 * needs, so the caller surfaces it through the notifications queue and
 * toast. Retrying allocation with the same provider instance resumes
 * the flow (claim poll, then sandbox create).
 *
 * Secrets: the relay token and navigation scope travel in per-sandbox
 * environment created with the sandbox. The only command ever sent is
 * the operator-configured agent start command, so Boat's command
 * history never sees a site secret; secrets cross per fill over the
 * relay. Sandboxes are created `noEnv` (none of the account's secrets),
 * monitoring off, snapshots off, and deleted on close.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BOAT_AGENT_ENV } from "./boat-agent.js";
import {
  BoatAgentAuth,
  type BoatAuthOptions,
  type BoatClaimMaterials,
  BoatClaimPendingError,
  type BoatTokenGrant,
} from "./boat-auth.js";
import {
  BoatApiError,
  BoatClient,
  type BoatClientOptions,
} from "./boat-client.js";
import {
  BOAT_READY_STATES,
  boatSleep,
  isBoatClaimUsable,
  requireBoatClaim,
  resolveBoatRegistration,
  snapshotBoatRegistration,
} from "./boat-registration-state.js";
import { relayDriverOverWebSocket } from "./relay-driver.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  SandboxClaimRequiredError,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

/**
 * Registration state that must survive the claim ceremony across
 * processes. It carries credentials (a claim token and identity
 * assertion), so hosts must protect it — never in a config file a
 * user might share. Access tokens are deliberately not persisted: the
 * assertion re-exchanges for a fresh one.
 */
export interface BoatProviderState {
  claimToken?: string;
  identityAssertion?: string;
  claimMaterials?: BoatClaimMaterials;
  claimIssuedAt?: number;
}

export interface BoatProviderOptions {
  /** Prebuilt clients (tests); otherwise built from options/environment. */
  client?: BoatClient;
  auth?: BoatAgentAuth;
  origin?: string;
  fetchImpl?: typeof fetch;
  /** Existing Boat API key; skips agent registration entirely. */
  apiToken?: string;
  /** Identity assertion from a prior registration (rotates to a token). */
  identityAssertion?: string;
  /** Claim token from a prior registration, to resume a pending claim. */
  claimToken?: string;
  /** Persisted registration state from a previous process. */
  state?: BoatProviderState;
  /** Called whenever registration state changes, to persist it securely. */
  onStateChange?: (state: BoatProviderState) => void | Promise<void>;
  /** The user's email, for the claim ceremony (`service_auth`). */
  claimEmail?: string;
  /**
   * Shell command that starts the relay agent inside the sandbox
   * (typically from a saved snapshot with this package installed). It
   * reads the `BOAT_AGENT_ENV` variables; see `boat-agent.ts`.
   */
  agentCommand?: string;
  /** Saved snapshot to create sandboxes from. */
  fromSnapshot?: string;
  /** Stop (archive) instead of permanently deleting on close. */
  keepSandbox?: boolean;
  readyTimeoutMs?: number;
  agentReadyTimeoutMs?: number;
  pollIntervalMs?: number;
}

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
    return (this.options.origin ?? "https://boat.dev").replace(/\/$/u, "");
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

  private async adoptGrant(grant: BoatTokenGrant): Promise<string> {
    if (grant.identityAssertion) {
      this.identityAssertion = grant.identityAssertion;
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
    if (this.claimToken) {
      try {
        return await this.adoptGrant(await auth.pollClaim(this.claimToken));
      } catch (error) {
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
          await this.adoptClaim(
            await auth.requestClaim(this.claimToken, email),
          );
        requireBoatClaim(
          this.claimMaterials,
          this.claimToken,
          this.claimIssuedAt,
        );
      }
    }
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
    requireBoatClaim(this.claimMaterials, this.claimToken, this.claimIssuedAt);
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
          );
          return this.createSandbox(liveToken, input, true);
        } catch (pollError) {
          if (!(pollError instanceof BoatClaimPendingError)) throw pollError;
        }
      }
      return this.surfaceGate(error, token);
    }
  }

  private async waitReady(token: string, sandboxId: string): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 180_000);
    const interval = this.options.pollIntervalMs ?? 2_000;
    for (;;) {
      const sandbox = await this.client().getSandbox(token, sandboxId);
      if (BOAT_READY_STATES.has(sandbox.state)) return;
      if (sandbox.state === "error")
        throw new Error(`boat: sandbox ${sandboxId} entered error state`);
      if (Date.now() > deadline)
        throw new Error(`boat: sandbox ${sandboxId} did not become ready`);
      await boatSleep(interval);
    }
  }

  /** Wait until the in-sandbox relay accepts a WebSocket upgrade. */
  private async waitForRelay(webSocketUrl: string): Promise<void> {
    const deadline = Date.now() + (this.options.agentReadyTimeoutMs ?? 60_000);
    const interval = this.options.pollIntervalMs ?? 1_000;
    for (;;) {
      const opened = await new Promise<boolean>((resolve) => {
        const probe = new WebSocket(webSocketUrl);
        probe.once("open", () => {
          probe.close();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (opened) return;
      if (Date.now() > deadline)
        throw new Error("boat: relay agent did not start in the sandbox");
      await boatSleep(interval);
    }
  }

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const agentCommand =
      this.options.agentCommand ?? process.env.BOAT_RELAY_AGENT_COMMAND;
    if (!agentCommand)
      throw new Error(
        "boat provider needs an agent start command (BOAT_RELAY_AGENT_COMMAND)",
      );
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
      await this.waitReady(liveToken, sandboxId);
      await client.startDetachedCommand(liveToken, sandboxId, agentCommand);
      const hostedUrl = await client.hostPort(liveToken, sandboxId, RELAY_PORT);
      const webSocketUrl = hostedUrl.replace(/^http/u, "ws");
      await this.waitForRelay(webSocketUrl);
      const browser = relayDriverOverWebSocket(webSocketUrl, {
        token: relayToken,
      });
      return {
        provider: this.id,
        session: sandboxId,
        browser,
        allowedDomains,
        close: async () => {
          await browser.close().catch(() => {});
          if (this.options.keepSandbox)
            await client.stopSandbox(liveToken, sandboxId);
          else await client.deleteSandbox(liveToken, sandboxId);
        },
      };
    } catch (error) {
      await client.deleteSandbox(liveToken, sandboxId).catch(() => {});
      throw error;
    }
  }
}
