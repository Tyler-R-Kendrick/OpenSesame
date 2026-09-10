import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type createLocalAgentKey,
  localMessage,
} from "@opensesame/static-auth";
import { expect, vi } from "vitest";
import type { LocalAuthorizationRequest } from "./local-authorization.js";
import { LocalIssuerChannel } from "./local-issuer-channel.js";
import {
  type LocalSession,
  revokeLocalIdentitySession,
} from "./local-sessions.js";

type ChannelCase = {
  tomb: string;
  request: LocalAuthorizationRequest;
  key: Awaited<ReturnType<typeof createLocalAgentKey>>;
  humanSession: LocalSession;
  agent: string;
  app: string;
  verifier: string;
  origin: string;
};

function channelFixture(tomb: string, request: LocalAuthorizationRequest) {
  const opener = { closed: false, postMessage: vi.fn() };
  const browser = Object.assign(new EventTarget(), { opener });
  vi.stubGlobal("window", browser);
  const status = vi.fn();
  const issuer = new LocalIssuerChannel(tomb, request, status);
  const pipe = new MessageChannel();
  const inbox: NonNullable<ReturnType<typeof localMessage>>[] = [];
  pipe.port1.onmessage = (event: MessageEvent<BoundaryValue>) => {
    const message = localMessage(event.data, request.state);
    if (message) inbox.push(message);
  };
  async function take(type: string) {
    await vi.waitFor(() =>
      expect(inbox.some((row) => row.type === type)).toBe(true),
    );
    const message = inbox.find((row) => row.type === type);
    if (!message) throw new Error("Missing channel response");
    return message;
  }
  browser.dispatchEvent(
    Object.assign(new Event("message"), {
      origin: new URL(request.redirectUri).origin,
      source: opener,
      data: { type: "opensesame:local:connect", state: request.state },
      ports: [pipe.port2],
    }),
  );

  return { issuer, pipe, take, status };
}

export async function verifyAgentApplicationChannel(input: ChannelCase) {
  const { tomb, request, key, humanSession, agent, app, verifier, origin } =
    input;
  const { issuer, pipe, take, status } = channelFixture(tomb, {
    ...request,
    agent: { principalId: agent, keyId: key.keyId },
  });
  try {
    const challenge = await take("agent_challenge");
    expect(status).not.toHaveBeenCalled();
    await expect(issuer.approveAgent(humanSession)).rejects.toThrow(
      "agent_proof_required",
    );
    const proof = await key.signChallenge(
      {
        nonce: String(challenge.nonce),
        principalId: String(challenge.principalId),
        keyId: String(challenge.keyId),
        origin: String(challenge.origin),
        expiresAt: Number(challenge.expiresAt),
      },
      origin,
      agent,
    );
    pipe.port1.postMessage({
      type: "agent_proof",
      proof,
      state: request.state,
      id: "1",
    });
    await take("agent_verified");
    await expect(issuer.approve(humanSession)).rejects.toThrow(
      "explicit_agent_consent_required",
    );
    await issuer.approveAgent(humanSession);
    const code = await take("code");
    pipe.port1.postMessage({
      type: "redeem",
      code: code.code,
      verifier,
      state: request.state,
      id: "2",
    });
    expect(await take("identity")).toMatchObject({
      sub: agent,
      audience: app,
      scope: "openid",
    });
    await revokeLocalIdentitySession(tomb, humanSession.id);
    pipe.port1.postMessage({
      type: "userinfo",
      scope: "openid",
      state: request.state,
      id: "3",
    });
    expect(await take("error")).toMatchObject({
      error: "authorization_unavailable",
    });
  } finally {
    issuer.close();
    pipe.port1.close();
    pipe.port2.close();
  }
}
