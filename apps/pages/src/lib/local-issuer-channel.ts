import { type BoundaryValue, isString } from "@opensesame/os-domain";
import {
  type LocalAgentChallenge,
  type LocalAuthorizationRequest,
  localMessage,
} from "@opensesame/static-auth";
import { decideLocalAccessRequest } from "./local-access-requests.js";
import {
  beginLocalAgentAuthentication,
  cancelLocalAgentAuthentication,
} from "./local-agent-auth.js";
import { readLocalAgentKeys } from "./local-agent-keys.js";
import { withLocalApplicationApproval } from "./local-application-approval.js";
import {
  type LocalApplicationGrant,
  redeemLocalApplicationCode,
  revokeLocalApplicationGrant,
  withLocalApplicationGrant,
} from "./local-authorization.js";
import {
  createLocalApplicationRequest,
  redeemLocalApplicationRequest,
} from "./local-request-authorization.js";
import { type LocalSession, signInLocalAgent } from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";

export type LocalIssuerStatus =
  | "waiting"
  | "connected"
  | "approved"
  | "active"
  | "closed";

/** One popup, one opener and one transferred port. Grant handles never cross it. */
export class LocalIssuerChannel {
  private readonly request: LocalAuthorizationRequest;
  private readonly opener: Window;
  private readonly origin: string;
  private port: MessagePort | null = null;
  private closed = false;
  private approved = false;
  private busy = false;
  private session: LocalSession | null = null;
  private agentSession: LocalSession | null = null;
  private challenge: LocalAgentChallenge | null = null;
  private grant: LocalApplicationGrant | null = null;
  private lastId = 0;
  private timer: ReturnType<typeof setTimeout>;
  private readonly offLock: () => void;

  constructor(
    private readonly tomb: string,
    input: LocalAuthorizationRequest,
    private readonly status: (next: LocalIssuerStatus) => void,
  ) {
    this.request = structuredClone(input);
    const opener: Window | null = window.opener;
    if (!opener || opener.closed) throw new Error("missing_relying_party");
    this.opener = opener;
    this.origin = new URL(this.request.redirectUri).origin;
    this.timer = setTimeout(this.close, 300_000);
    this.offLock = vaultStore.onLock(this.close);
    window.addEventListener("message", this.connect);
    window.addEventListener("pagehide", this.close);
    opener.postMessage(
      { type: "opensesame:local:ready", state: this.request.state },
      this.origin,
    );
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.offLock();
    window.removeEventListener("message", this.connect);
    window.removeEventListener("pagehide", this.close);
    this.port?.postMessage({ type: "closed", state: this.request.state });
    this.port?.close();
    this.grant = null;
    this.session = null;
    this.agentSession = null;
    if (this.challenge)
      cancelLocalAgentAuthentication(this.tomb, this.challenge.nonce);
    this.challenge = null;
    this.status("closed");
  };

  private connect = (event: MessageEvent<BoundaryValue>) => {
    if (
      this.closed ||
      this.port ||
      event.source !== this.opener ||
      event.origin !== this.origin ||
      event.ports.length !== 1
    )
      return;
    const message = localMessage(event.data, this.request.state);
    if (message?.type !== "opensesame:local:connect") return;
    this.port = event.ports[0];
    this.port.onmessage = (event: MessageEvent<BoundaryValue>) => {
      void this.receive(event.data);
    };
    this.port.onmessageerror = this.close;
    this.port.start();
    if (this.request.agent) void this.challengeAgent().catch(this.close);
    else this.status("connected");
  };

  private async challengeAgent() {
    const agent = this.request.agent;
    if (!agent) throw new Error("missing_agent");
    const key = (await readLocalAgentKeys(this.tomb)).find(
      (row) =>
        row.principalId === agent.principalId && row.keyId === agent.keyId,
    );
    if (!key || this.closed) throw new Error("unavailable_agent");
    const challenge = await beginLocalAgentAuthentication(
      this.tomb,
      agent.principalId,
      key.credentialId,
    );
    if (this.closed) {
      cancelLocalAgentAuthentication(this.tomb, challenge.nonce);
      return;
    }
    this.challenge = challenge;
    this.port?.postMessage({
      type: "agent_challenge",
      state: this.request.state,
      ...challenge,
      expiresAt: String(challenge.expiresAt),
    });
  }

  private async receive(data: BoundaryValue) {
    const message = localMessage(data, this.request.state);
    if (
      this.closed ||
      this.busy ||
      !message ||
      !isString(message.id) ||
      !/^[1-9][0-9]{0,5}$/.test(message.id)
    )
      return this.close();
    const id = Number(message.id);
    if (id <= this.lastId) return this.close();
    this.lastId = id;
    this.busy = true;
    try {
      const result = await this.dispatch(message);
      if (!this.closed)
        this.port?.postMessage({
          ...result,
          id: message.id,
          state: this.request.state,
        });
      if (result.type === "revoked") this.close();
    } catch {
      this.port?.postMessage({
        type: "error",
        id: message.id,
        state: this.request.state,
        error: "authorization_unavailable",
      });
      this.close();
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(
    message: NonNullable<ReturnType<typeof localMessage>>,
  ) {
    if (message.type === "agent_proof") return this.verifyAgent(message.proof);
    return this.dispatchApproved(message);
  }

  private async verifyAgent(proof: BoundaryValue) {
    if (
      this.challenge &&
      !this.agentSession &&
      !this.approved &&
      isString(proof)
    ) {
      const challenge = this.challenge;
      this.challenge = null;
      this.agentSession = await signInLocalAgent(
        this.tomb,
        challenge.nonce,
        proof,
      );
      if (this.closed) throw new Error("closed");
      this.status("connected");
      return { type: "agent_verified" };
    }
    throw new Error("agent_proof_unavailable");
  }

  private async dispatchApproved(
    message: NonNullable<ReturnType<typeof localMessage>>,
  ) {
    if (!this.approved || !this.session) throw new Error("consent_required");
    if (
      message.type === "redeem" &&
      !this.grant &&
      isString(message.code) &&
      isString(message.verifier)
    ) {
      const next = await redeemLocalApplicationCode(this.tomb, {
        code: message.code,
        codeVerifier: message.verifier,
        applicationId: this.request.applicationId,
        redirectUri: this.request.redirectUri,
      });
      if (this.closed) throw new Error("closed");
      this.grant = next;
      clearTimeout(this.timer);
      this.timer = setTimeout(
        this.close,
        Math.max(0, next.expiresAt - Date.now()),
      );
      const result = await this.claims();
      if (!this.closed) this.status("active");
      return result;
    }
    if (message.type === "userinfo" && this.grant && isString(message.scope))
      return this.claims(message.scope);
    if (message.type === "revoke" && this.grant) {
      await revokeLocalApplicationGrant(this.tomb, this.session, this.grant.id);
      this.grant = null;
      return { type: "revoked" };
    }
    throw new Error("invalid_operation");
  }

  private async claims(scope = "openid") {
    if (!this.grant || !this.session) throw new Error("missing_grant");
    const authTime = this.session.authTime;
    return withLocalApplicationGrant(
      this.tomb,
      this.grant,
      this.request.applicationId,
      [...new Set(["openid", scope])],
      async (record) => ({
        type: "identity",
        issuer: location.origin,
        sub: record.principalId,
        audience: record.applicationId,
        nonce: record.nonce,
        scope,
        authTime: String(authTime),
        expiresAt: String(record.expiresAt),
      }),
    );
  }

  async approve(identity: LocalSession) {
    if (this.request.agent) throw new Error("explicit_agent_consent_required");
    return this.approveIdentity(identity);
  }

  async inspectApproval(identity: LocalSession) {
    if (this.closed || !this.port || (this.request.agent && !this.agentSession))
      throw new Error("channel_unavailable");
    const approval = this.agentSession
      ? { session: this.agentSession, approver: identity }
      : { session: identity };
    return withLocalApplicationApproval(
      this.tomb,
      approval,
      this.request,
      async () => undefined,
    );
  }

  /** The caller must display the requested agent before explicit human consent. */
  async approveAgent(identity: LocalSession) {
    if (!this.request.agent || !this.agentSession)
      throw new Error("agent_proof_required");
    return this.approveIdentity(identity);
  }

  private async approveIdentity(identity: LocalSession) {
    if (this.closed || !this.port || this.approved)
      throw new Error("channel_unavailable");
    this.approved = true;
    this.session = this.agentSession ?? identity;
    const approval = this.agentSession
      ? { session: this.agentSession, approver: identity }
      : { session: identity };
    try {
      const pending = await createLocalApplicationRequest(
        this.tomb,
        approval.session,
        this.request,
      );
      if (this.closed) throw new Error("closed");
      const decided = await decideLocalAccessRequest(this.tomb, {
        ...pending,
        principalId: identity.principalId,
        decision: "approve",
      });
      if (this.closed) throw new Error("closed");
      const response = await redeemLocalApplicationRequest(
        this.tomb,
        approval,
        decided,
        this.request,
      );
      if (this.closed) throw new Error("closed");
      this.status("approved");
      this.port.postMessage({
        type: "code",
        state: this.request.state,
        code: response.code,
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
