import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import { nativeApiDraft } from "./native-api.test-support.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";

export type OracleProvider =
  | "similarweb"
  | "telegram"
  | "openai"
  | "anthropic"
  | "mailgun"
  | "datadog";
export const operationKey = "123:private~operation-token";
export function deferredOperation() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function oracleAuthority(
  provider: OracleProvider,
  request: IncomingMessage,
): boolean {
  const url = new URL(request.url ?? "/", "https://oracle.test");
  if (provider === "similarweb")
    return (
      url.searchParams.getAll("api_key").length === 1 &&
      url.searchParams.get("api_key") === operationKey
    );
  if (provider === "telegram")
    return url.pathname.startsWith(`/bot${encodeURIComponent(operationKey)}/`);
  if (provider === "anthropic")
    return (
      request.headers["x-api-key"] === operationKey &&
      request.headers["anthropic-version"] === "2023-06-01" &&
      request.headers["anthropic-dangerous-direct-browser-access"] === "true"
    );
  if (provider === "mailgun")
    return (
      request.headers.authorization ===
      `Basic ${Buffer.from(`api:${operationKey}`).toString("base64")}`
    );
  if (provider === "datadog")
    return (
      request.headers["dd-api-key"] === operationKey &&
      request.headers["dd-application-key"] === "secondary-private-key"
    );
  return request.headers.authorization === `Bearer ${operationKey}`;
}
function logicalOrigin(provider: OracleProvider): string {
  return {
    similarweb: "https://api.similarweb.com",
    telegram: "https://api.telegram.org",
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    mailgun: "https://api.mailgun.net",
    datadog: "https://api.datadoghq.com",
  }[provider];
}
function oracleCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-api-operation-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
/** Independent auth oracle, real pinned TLS and actual streamed response bodies. */
export async function operationOracle(provider: OracleProvider) {
  const tls = oracleCertificate();
  const requests: {
    method: string;
    path: string;
    body: string;
    authorized: boolean;
  }[] = [];
  let respond = (_request: IncomingMessage, response: ServerResponse) => {
    response.end(
      JSON.stringify(
        provider === "telegram"
          ? { ok: true, result: { id: 17, username: "owned_bot" } }
          : { name: "Owned API", data: [], status: "ok" },
      ),
    );
  };
  const server = createServer(tls, async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const authorized = oracleAuthority(provider, request);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: Buffer.concat(parts).toString(),
      authorized,
    });
    response.setHeader("content-type", "application/json");
    if (!authorized) {
      response.writeHead(401);
      response.end("{}");
      return;
    }
    respond(request, response);
  });
  try {
    await once(server.listen(0, "127.0.0.1"), "listening");
  } catch (error) {
    rmSync(tls.directory, { recursive: true, force: true });
    throw error;
  }
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const owner = new AbortController();
  const realFetch = tlsFetch(tls.cert);
  const transport: NativeProviderTransport = {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
    supportsNativeOrigin: (origin) => origin === logicalOrigin(provider),
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== logicalOrigin(provider))
        throw new Error("Oracle refused an unexpected origin");
      return realFetch(
        new URL(url.pathname + url.search, `https://127.0.0.1:${port}`),
        init,
      );
    },
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(tls.directory, { recursive: true, force: true });
  };
  try {
    const credentials: Record<string, string> =
      provider === "datadog"
        ? { api_key: operationKey, application_key: "secondary-private-key" }
        : { api_key: operationKey };
    const view = await configureNativeApiConnector(
      { ...nativeApiDraft(provider), credentials },
      transport,
    );
    return {
      view,
      transport,
      owner,
      requests,
      close,
      reply: (write: typeof respond) => {
        respond = write;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
