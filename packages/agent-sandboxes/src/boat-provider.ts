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
} from "./boat-auth.js";
import {
  BoatApiError,
  BoatClient,
  type BoatClientOptions,
} from "./boat-client.js";
import { relayDriverOverWebSocket } from "./relay-driver.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  SandboxClaimRequiredError,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

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
const READY_STATES = new Set(["ready", "idle", "running"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BoatSandboxProvider implements SandboxProvider {
  readonly id = "boat" as const;

  private accessToken: string | undefined;
  private identityAssertion: string | undefined;
  private claimToken: string | undefined;
  private claimMaterials: BoatClaimMaterials | undefined;

  constructor(private readonly options: BoatProviderOptions = {}) {
    this.accessToken =
      options.apiToken ??
      process.env.BOAT_API_KEY ??
      process.env.BOAT_API_TOKEN;
    this.identityAssertion =
      options.identityAssertion ?? process.env.BOAT_IDENTITY_ASSERTION;
    this.claimToken = options.claimToken ?? process.env.BOAT_CLAIM_TOKEN;
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

  private claimRequired(materials?: BoatClaimMaterials): never {
    const claim = materials ?? this.claimMaterials;
    if (claim)
      throw new SandboxClaimRequiredError({
        verificationUri: claim.verificationUri,
        userCode: claim.userCode,
      });
    throw new SandboxClaimRequiredError({
      verificationUri: `${this.origin}/api/boat/agent/identity/claim`,
    });
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const auth = this.auth();
    if (this.claimToken) {
      try {
        const grant = await auth.pollClaim(this.claimToken);
        this.accessToken = grant.accessToken;
        if (grant.identityAssertion)
          this.identityAssertion = grant.identityAssertion;
        return grant.accessToken;
      } catch (error) {
        if (!(error instanceof BoatClaimPendingError)) throw error;
        const email = this.claimEmail;
        if (email && !this.claimMaterials)
          this.claimMaterials = await auth.requestClaim(this.claimToken, email);
        this.claimRequired();
      }
    }
    if (this.identityAssertion) {
      const grant = await auth.exchangeAssertion(this.identityAssertion);
      this.accessToken = grant.accessToken;
      if (grant.identityAssertion)
        this.identityAssertion = grant.identityAssertion;
      return grant.accessToken;
    }
    const registration = await auth.register(this.claimEmail);
    this.claimToken = registration.claimToken;
    if (registration.claim) this.claimMaterials = registration.claim;
    if (!registration.identityAssertion) this.claimRequired();
    this.identityAssertion = registration.identityAssertion;
    const grant = await auth.exchangeAssertion(registration.identityAssertion);
    this.accessToken = grant.accessToken;
    if (grant.identityAssertion)
      this.identityAssertion = grant.identityAssertion;
    return grant.accessToken;
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
      this.claimMaterials = await this.auth().requestClaim(
        this.claimToken,
        email,
      );
    this.claimRequired();
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
          const grant = await this.auth().pollClaim(this.claimToken);
          this.accessToken = grant.accessToken;
          if (grant.identityAssertion)
            this.identityAssertion = grant.identityAssertion;
          return this.createSandbox(grant.accessToken, input, true);
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
      if (READY_STATES.has(sandbox.state)) return;
      if (sandbox.state === "error")
        throw new Error(`boat: sandbox ${sandboxId} entered error state`);
      if (Date.now() > deadline)
        throw new Error(`boat: sandbox ${sandboxId} did not become ready`);
      await sleep(interval);
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
      await sleep(interval);
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
