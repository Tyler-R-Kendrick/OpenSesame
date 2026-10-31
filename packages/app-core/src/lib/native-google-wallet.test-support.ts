/** Independent RSA/JWT and CA-verified HTTPS oracle, never a mocked Wallet success. */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { deferred } from "./secret-backends/runtime.test-support.js";
export const walletIssuer = "3388000000022125777";
export const walletClass = `${walletIssuer}.operator`;
export const walletOrigin = "https://operator.example.test";
export const walletEmail = "wallet@operator-project.iam.gserviceaccount.com";
export const walletToken = "controlled-wallet-provider-access-token";
export const walletTokenUrl = "https://oauth2.googleapis.com/token";
export const walletClassUrl = `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${walletClass}`;
type Stage = "token" | "class";
type Reply = { body: BoundaryValue; status: number };
function keys() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "google-wallet-native-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost".split(
        " ",
      ),
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  return { directory, key: readFileSync(key), cert: readFileSync(cert) };
}
function jwt(value: string, pair: ReturnType<typeof keys>) {
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      pair.publicKey,
      Buffer.from(parts[2] ?? "", "base64url"),
    )
  )
    throw new Error("Independent Wallet JWT signature check failed");
  const header: BoundaryValue = JSON.parse(
    Buffer.from(parts[0] ?? "", "base64url").toString(),
  );
  const claims: BoundaryValue = JSON.parse(
    Buffer.from(parts[1] ?? "", "base64url").toString(),
  );
  if (
    !isJsonObject(header) ||
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    !isJsonObject(claims)
  )
    throw new Error("Wrong JWT envelope");
  return claims;
}
function validGrant(body: string, pair: ReturnType<typeof keys>): boolean {
  try {
    const form = new URLSearchParams(body);
    if (
      form.size !== 2 ||
      form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
      return false;
    const claims = jwt(form.get("assertion") ?? "", pair);
    return (
      claims.iss === walletEmail &&
      claims.aud === walletTokenUrl &&
      claims.scope === "https://www.googleapis.com/auth/wallet_object.issuer" &&
      Number.isInteger(claims.iat) &&
      Number.isInteger(claims.exp) &&
      Number(claims.exp) - Number(claims.iat) === 3600 &&
      Math.abs(Number(claims.iat) - Date.now() / 1000) < 10
    );
  } catch {
    return false;
  }
}
function authenticated(
  request: IncomingMessage,
  stage: Stage,
  body: string,
  pair: ReturnType<typeof keys>,
): boolean {
  if (request.headers.cookie !== undefined) return false;
  if (stage === "token")
    return (
      request.method === "POST" &&
      request.headers["content-type"] === "application/x-www-form-urlencoded" &&
      validGrant(body, pair)
    );
  return (
    request.method === "GET" &&
    request.url === new URL(walletClassUrl).pathname &&
    request.headers.authorization === `Bearer ${walletToken}`
  );
}
function ownedTransport(
  owner: AbortController,
  port: number,
  cert: Uint8Array,
): NativeProviderTransport {
  const actual = tlsFetch(cert);
  return {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
    supportsNativeOrigin: (origin) =>
      [new URL(walletTokenUrl).origin, new URL(walletClassUrl).origin].includes(
        origin,
      ),
    fetch: async (input, init) => {
      owner.signal.throwIfAborted();
      const request = new Request(input, init);
      if (![walletTokenUrl, walletClassUrl].includes(request.url))
        throw new Error("Unowned Wallet destination");
      const forwarded: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      };
      if (request.body !== null) forwarded.body = await request.arrayBuffer();
      owner.signal.throwIfAborted();
      return actual(
        new URL(new URL(request.url).pathname, `https://127.0.0.1:${port}`),
        forwarded,
      );
    },
  };
}
export async function walletOracle() {
  const pair = keys();
  const tls = certificate();
  const owner = new AbortController();
  const account = JSON.stringify({
    type: "service_account",
    project_id: "operator-project",
    client_email: walletEmail,
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const replies = new Map<Stage, Reply>();
  const requests: { path: string; stage: Stage; authorized: boolean }[] = [];
  let held:
    | {
        stage: Stage;
        arrived: ReturnType<typeof deferred<void>>;
        closed: ReturnType<typeof deferred<void>>;
        response?: ServerResponse;
      }
    | undefined;
  const defaultBody = (stage: Stage) =>
    stage === "token"
      ? { access_token: walletToken, expires_in: 3600, token_type: "Bearer" }
      : { id: walletClass };
  const server = createServer(tls, async (request, response) => {
    const stage: Stage = request.url === "/token" ? "token" : "class";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const authorized = authenticated(
      request,
      stage,
      Buffer.concat(chunks).toString(),
      pair,
    );
    requests.push({ path: request.url ?? "", stage, authorized });
    response.setHeader("content-type", "application/json");
    if (!authorized) {
      response.writeHead(401).end("{}");
      return;
    }
    if (held?.stage === stage) {
      held.response = response;
      const capture = held;
      response.once("close", () => capture.closed.resolve());
      response.write(" ");
      held.arrived.resolve();
      return;
    }
    response.writeHead(replies.get(stage)?.status ?? 200);
    response.end(
      JSON.stringify(replies.get(stage)?.body ?? defaultBody(stage)),
    );
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const transport = ownedTransport(owner, port, tls.cert);
  return {
    account,
    wrongAccount() {
      return JSON.stringify({
        ...JSON.parse(account),
        private_key: keys().privateKey.export({ type: "pkcs8", format: "pem" }),
      });
    },
    requests,
    transport,
    owner,
    reply(stage: Stage, body: BoundaryValue, status = 200) {
      replies.set(stage, { body, status });
    },
    hold(stage: Stage) {
      held = { stage, arrived: deferred<void>(), closed: deferred<void>() };
      const capture = held;
      return {
        ...capture,
        release() {
          capture.response?.end(JSON.stringify(defaultBody(stage)));
          held = undefined;
        },
      };
    },
    verifySave(url: string) {
      if (!url.startsWith("https://pay.google.com/gp/v/save/"))
        throw new Error("Wrong Save destination");
      return jwt(url.slice("https://pay.google.com/gp/v/save/".length), pair);
    },
    async close() {
      owner.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
