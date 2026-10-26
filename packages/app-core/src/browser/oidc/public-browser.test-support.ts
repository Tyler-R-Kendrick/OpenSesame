/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
// Real default fetch/HTTP/JOSE/admission; popup/OPFS are explicit browser-port doubles.
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { BroadcastChannel } from "node:worker_threads";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import { configureHost, host } from "../../host.js";
import { loopbackProfileEligible } from "../../lib/__tests__/loopback-profile.js";
import { webLocksDouble } from "../../lib/__tests__/web-locks-double.js";
import { identityConnectionDraft } from "../../lib/identity-connections.js";
import { localNetworkFetchSeams } from "../../lib/local-network-fetch.js";
import { fixture } from "../../lib/origin-file-publication-custody.test-support.js";
import { page } from "../../ports.js";
import {
  captureNativeAuthCode,
  nativeAuthChannel,
  nativeAuthRandom,
} from "../native-auth-message.js";
import "./oidc.test-support.js";

type Wire = {
  issuer: string;
  keys: Awaited<ReturnType<typeof generateKeyPair>>;
  nonce: string;
  challenge: string;
  organization: string;
  used: boolean;
  fault: "" | "nonce" | "organization";
  beforeToken: () => void;
  requests: string[];
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function json(response: ServerResponse, value: BoundaryValue): void {
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://pwa.example.test",
  });
  response.end(JSON.stringify(value));
}
async function token(
  wire: Wire,
  body: URLSearchParams,
  response: ServerResponse,
) {
  const verifier = body.get("code_verifier") ?? "";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (
    wire.used ||
    body.get("client_id") !== "public-browser-client" ||
    body.get("grant_type") !== "authorization_code" ||
    body.get("code") !== "public-once" ||
    challenge !== wire.challenge
  ) {
    response.writeHead(400).end();
    return;
  }
  wire.used = true;
  const assertion = await new SignJWT({
    nonce: wire.fault === "nonce" ? "wrong-original-nonce" : wire.nonce,
    org_id: wire.fault === "organization" ? "wrong-org" : wire.organization,
    auth_time: Math.floor(Date.now() / 1000),
    email: "verified@example.test",
  })
    .setProtectedHeader({ alg: "ES256", kid: "original-public-key" })
    .setIssuer(wire.issuer)
    .setAudience("public-browser-client")
    .setSubject("browser-person")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(wire.keys.privateKey);
  wire.beforeToken();
  json(response, {
    token_type: "Bearer",
    access_token: "public-synthetic-access-token",
    id_token: assertion,
  });
}
async function request(
  wire: Wire,
  incoming: IncomingMessage,
  response: ServerResponse,
) {
  const path = incoming.url ?? "/";
  wire.requests.push(path);
  incoming.setEncoding("utf8");
  let raw = "";
  for await (const part of incoming) raw += String(part);
  const body = new URLSearchParams(raw);
  if (path === "/.well-known/openid-configuration") {
    json(response, {
      issuer: wire.issuer,
      authorization_endpoint: `${wire.issuer}/authorize`,
      token_endpoint: `${wire.issuer}/token`,
      jwks_uri: `${wire.issuer}/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code"],
    });
  } else if (path === "/jwks") {
    const jwk = await exportJWK(wire.keys.publicKey);
    json(response, {
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          x: jwk.x ?? "",
          y: jwk.y ?? "",
          alg: "ES256",
          kid: "original-public-key",
        },
      ],
    });
  } else if (path === "/token") {
    await token(wire, body, response);
  } else response.writeHead(404).end();
}
async function provider() {
  const wire: Wire = {
    issuer: "",
    keys: await generateKeyPair("ES256"),
    nonce: "",
    challenge: "",
    organization: "",
    used: false,
    fault: "",
    beforeToken: () => {},
    requests: [],
  };
  const server = createServer((incoming, response) => {
    void request(wire, incoming, response).catch(() =>
      response.writeHead(500).end(),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  });
  const { port } = z
    .object({ port: z.number().int().positive().max(65535) })
    .parse(server.address());
  wire.issuer = `http://127.0.0.1:${port}`;
  return wire;
}
export function popup(wire: Wire) {
  const channels: BroadcastChannel[] = [];
  const errors: unknown[] = [];
  const value = {
    opener: window,
    closed: false,
    close: vi.fn(),
    location: {
      href: "about:blank",
      replace: (href: string) => {
        value.location.href = href;
        const authorization = new URL(href);
        wire.nonce = authorization.searchParams.get("nonce") ?? "";
        wire.challenge = authorization.searchParams.get("code_challenge") ?? "";
        wire.organization =
          authorization.searchParams.get("organization") ?? "";
        expect(authorization.searchParams.get("code_challenge_method")).toBe(
          "S256",
        );
        const callback = new URL(
          authorization.searchParams.get("redirect_uri") ?? "",
        );
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state") ?? "",
        );
        callback.searchParams.set("code", "public-once");
        const code = captureNativeAuthCode(callback);
        if (!code)
          throw new Error("Real static callback parser refused original code");
        void nativeAuthChannel(code.state)
          .then((name) => {
            const channel = new BroadcastChannel(name);
            channels.push(channel);
            channel.onmessage = () => channel.close();
            callback.search = "";
            channel.postMessage({
              kind: "authorization-code",
              redirectUri: callback.href,
              receipt: nativeAuthRandom(),
              ...code,
            });
          })
          .catch((error) => errors.push(error));
      },
    },
  };
  // SAFETY: the controlled Window port supplies exactly the opener/location/close members read by the real popup protocol.
  vi.spyOn(page(), "open").mockReturnValue(
    overlapCast<typeof value, Window>(value),
  );
  cleanups.push(() => {
    for (const channel of channels) channel.close();
  });
  return { errors, close: value.close };
}
export async function publicContext() {
  vi.spyOn(localNetworkFetchSeams, "eligible").mockImplementation(
    loopbackProfileEligible,
  );
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  fixture();
  const original = host();
  configureHost({
    ...original,
    env: { ...original.env, BASE_URL: "/OpenSesame/" },
  });
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  const wire = await provider();
  const draft = {
    ...identityConnectionDraft("byo-identity"),
    issuer: wire.issuer,
    clientId: "public-browser-client",
    oidcTokenAuthentication: "none" as const,
  };
  return { wire, draft };
}

export function track(close: () => void | Promise<void>): void {
  cleanups.push(close);
}
