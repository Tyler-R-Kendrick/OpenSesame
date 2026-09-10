import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { createPkcePair } from "@opensesame/sdk-browser";
import type { LocalAgentChallenge } from "./local-agent.js";
import {
  type LocalAuthorizationRequest,
  localAuthorizationQuery,
  localMessage,
  parseLocalAuthorizationRequest,
} from "./local-protocol.js";
import { endpoint, exactOrigin } from "./transport.js";

export type LocalBrowserProfile = {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  agent?: {
    principalId: string;
    keyId: string;
    signChallenge: (challenge: LocalAgentChallenge) => Promise<string>;
  };
};
export type LocalBrowserIdentity = Readonly<{
  subject: string;
  audience: string;
  issuer: string;
  authTime: number;
  expiresAt: number;
}>;
type Envelope = NonNullable<ReturnType<typeof localMessage>>;
type ExchangeFields = {
  code?: string;
  verifier?: string;
  scope?: string;
  proof?: string;
};

function validChallengeExpiry(expiresAt: number) {
  const now = Date.now();
  return (
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    expiresAt - now <= 120_000
  );
}

function matchesSubject(
  sub: BoundaryValue,
  agent: LocalAuthorizationRequest["agent"],
): sub is string {
  return (
    isString(sub) &&
    /^local_[0-9a-f-]{36}$/.test(sub) &&
    (!agent || sub === agent.principalId)
  );
}

/** Call directly from a human click. No tokens or verifier enter URLs/storage. */
export async function signInLocalBrowser(profile: LocalBrowserProfile) {
  const url = new URL(endpoint(profile.authorizationEndpoint));
  if (new URL(profile.redirectUri).origin !== exactOrigin(location.origin))
    throw new Error("invalid_redirect");
  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=640,height=800",
  );
  if (!popup) throw new Error("popup_blocked");
  try {
    const pkce = await createPkcePair();
    const request: LocalAuthorizationRequest = {
      applicationId: profile.clientId,
      redirectUri: profile.redirectUri,
      scopes: [...profile.scopes],
      state: pkce.state,
      nonce: pkce.nonce,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: "S256",
    };
    if (profile.agent)
      request.agent = {
        principalId: profile.agent.principalId,
        keyId: profile.agent.keyId,
      };
    url.search = localAuthorizationQuery(request);
    parseLocalAuthorizationRequest(url.search);
    const channel = new LocalBrowserChannel(
      popup,
      url.origin,
      request,
      pkce.codeVerifier,
      profile.agent?.signChallenge,
    );
    const result = channel.authorize();
    popup.location.replace(url.href);
    return await result;
  } catch (error) {
    popup.close();
    throw error;
  }
}

class LocalBrowserChannel {
  private readonly channel = new MessageChannel();
  private connected = false;
  private closed = false;
  private receivedCode = false;
  private receivedChallenge = false;
  private agentVerified = false;
  private counter = 0;
  private reply: {
    id: string;
    resolve: (value: Envelope) => void;
    reject: (error: Error) => void;
  } | null = null;
  private approve: ((identity: LocalBrowserIdentity) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private deadline = performance.now() + 300_000;
  private expiresAt: number | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly popup: Window,
    private readonly origin: string,
    private readonly request: LocalAuthorizationRequest,
    private readonly verifier: string,
    private readonly signChallenge?: (
      challenge: LocalAgentChallenge,
    ) => Promise<string>,
  ) {
    window.addEventListener("message", this.ready);
    window.addEventListener("pagehide", this.close);
    this.channel.port1.onmessage = (event: MessageEvent<BoundaryValue>) => {
      void this.receive(event.data);
    };
    this.channel.port1.onmessageerror = this.close;
    this.channel.port1.start();
    this.timer = setInterval(() => {
      if (popup.closed) this.fail("popup_closed");
      else if (
        performance.now() >= this.deadline ||
        (this.expiresAt !== null && Date.now() >= this.expiresAt)
      )
        this.fail("authorization_expired");
    }, 1000);
  }

  private fail(reason: string) {
    const error = new Error(reason);
    this.reject?.(error);
    const reply = this.reply;
    this.reply = null;
    reply?.reject(error);
    this.close();
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    window.removeEventListener("message", this.ready);
    window.removeEventListener("pagehide", this.close);
    this.channel.port1.close();
    this.channel.port2.close();
    this.popup.close();
    const error = new Error("local_session_closed");
    this.reject?.(error);
    this.reply?.reject(error);
    this.reply = null;
  };

  private ready = (event: MessageEvent<BoundaryValue>) => {
    if (
      this.closed ||
      this.connected ||
      event.source !== this.popup ||
      event.origin !== this.origin
    )
      return;
    if (
      localMessage(event.data, this.request.state)?.type !==
      "opensesame:local:ready"
    )
      return;
    this.connected = true;
    this.popup.postMessage(
      { type: "opensesame:local:connect", state: this.request.state },
      this.origin,
      [this.channel.port2],
    );
  };

  private async receive(data: BoundaryValue) {
    const message = localMessage(data, this.request.state);
    if (!message || message.type === "error") {
      return this.fail(
        message ? "authorization_unavailable" : "invalid_response",
      );
    }
    if (message.type === "closed") return this.close();
    if (message.type === "agent_challenge") {
      try {
        await this.proveAgent(message);
      } catch {
        this.fail("agent_authentication_failed");
      }
      return;
    }
    if (message.type === "code") {
      if (!this.acceptCode(message.code)) return this.close();
      this.receivedCode = true;
      try {
        const response = await this.rpc("redeem", {
          code: message.code,
          verifier: this.verifier,
        });
        const receivedAt = performance.now();
        const now = Date.now();
        const identity = this.identity(response, "openid", now);
        this.expiresAt = identity.expiresAt;
        // Clock corrections cannot lengthen an already-issued session.
        this.deadline = receivedAt + identity.expiresAt - now;
        this.approve?.(identity);
      } catch (error) {
        this.fail(
          error instanceof Error && error.message === "invalid_identity"
            ? "invalid_identity"
            : "local_session_unavailable",
        );
      }
      return;
    }
    if (this.reply && message.id === this.reply.id) {
      const reply = this.reply;
      this.reply = null;
      reply.resolve(message);
    } else this.close();
  }

  private acceptCode(code: BoundaryValue): code is string {
    return (
      (!this.request.agent || this.agentVerified) &&
      !this.receivedCode &&
      isString(code) &&
      /^[A-Za-z0-9_-]{43}$/.test(code)
    );
  }

  private async proveAgent(message: Envelope) {
    const agent = this.request.agent;
    const expiresAt = Number(message.expiresAt);
    if (
      !agent ||
      !this.signChallenge ||
      this.receivedChallenge ||
      this.receivedCode ||
      message.principalId !== agent.principalId ||
      message.keyId !== agent.keyId ||
      message.origin !== this.origin ||
      !isString(message.nonce) ||
      !/^[A-Za-z0-9_-]{43}$/.test(message.nonce) ||
      !validChallengeExpiry(expiresAt)
    )
      throw new Error("invalid_agent_challenge");
    this.receivedChallenge = true;
    const proof = await this.signChallenge({
      nonce: message.nonce,
      principalId: agent.principalId,
      keyId: agent.keyId,
      origin: this.origin,
      expiresAt,
    });
    if (!isString(proof) || proof.length > 2048 || Date.now() >= expiresAt)
      throw new Error("invalid_agent_proof");
    const response = await this.rpc("agent_proof", { proof });
    if (response.type !== "agent_verified")
      throw new Error("invalid_agent_response");
    this.agentVerified = true;
  }

  private rpc(type: string, extra: ExchangeFields = {}): Promise<Envelope> {
    if (this.closed || !this.connected || this.reply || this.counter >= 999999)
      return Promise.reject(new Error("local_session_unavailable"));
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("local_request_timeout"),
        10_000,
      );
      this.reply = {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.channel.port1.postMessage({
        type,
        state: this.request.state,
        id,
        ...extra,
      });
    });
  }

  private identity(
    message: Envelope,
    scope: string,
    now: number,
  ): LocalBrowserIdentity {
    const expiresAt = Number(message.expiresAt);
    const authTime = Number(message.authTime);
    if (
      message.type !== "identity" ||
      message.issuer !== this.origin ||
      message.audience !== this.request.applicationId ||
      message.nonce !== this.request.nonce ||
      message.scope !== scope ||
      !matchesSubject(message.sub, this.request.agent) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(authTime) ||
      authTime > now ||
      authTime < 0 ||
      expiresAt <= now ||
      expiresAt - authTime > 900_000
    )
      throw new Error("invalid_identity");
    return Object.freeze({
      subject: message.sub,
      audience: this.request.applicationId,
      issuer: this.origin,
      authTime,
      expiresAt,
    });
  }

  async authorize() {
    const identity = await new Promise<LocalBrowserIdentity>(
      (resolve, reject) => {
        this.approve = resolve;
        this.reject = reject;
      },
    );
    return {
      identity,
      check: async (scope = "openid") => {
        if (!this.request.scopes.includes(scope))
          throw new Error("scope_not_granted");
        return this.identity(
          await this.rpc("userinfo", { scope }),
          scope,
          Date.now(),
        );
      },
      revoke: async () => {
        try {
          await this.rpc("revoke");
        } finally {
          this.close();
        }
      },
      close: this.close,
    };
  }
}
