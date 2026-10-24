/** Independent Key Vault list/get authentication oracle over actual CA-verified TLS. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { deferred } from "./secret-backends/runtime.test-support.js";

export const azureVault = "https://owned.vault.azure.net";
export const azureToken = "controlled/key-vault~access-token";
export const azureValue = "explicitly-requested-secret-value";
export const azureVersion = "a".repeat(32);
export const azureList = {
  value: [
    {
      id: `${azureVault}/secrets/api-key`,
      tags: { private: "private-metadata" },
    },
  ],
};
export const azureBundle = {
  id: `${azureVault}/secrets/api-key/${azureVersion}`,
  value: azureValue,
};
export function azureDraft(providerId = "azure-sm") {
  return {
    providerId,
    displayName: "Owned secrets",
    parameters: { vault_url: azureVault },
    credentials: { token: azureToken },
  };
}
function authentic(request: IncomingMessage, url: URL, size: number): boolean {
  return (
    validRoute(url) &&
    request.method === "GET" &&
    size === 0 &&
    request.headers.authorization === `Bearer ${azureToken}` &&
    request.headers.accept === "application/json" &&
    request.headers.cookie === undefined
  );
}
function validRoute(url: URL): boolean {
  const list = url.pathname === "/secrets";
  return (
    (list || /^\/secrets\/api-key(?:\/[a-f0-9]{32})?$/.test(url.pathname)) &&
    url.searchParams.get("api-version") === "2025-07-01" &&
    url.searchParams.size === (list ? 2 : 1) &&
    (!list || url.searchParams.get("maxresults") === "25")
  );
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "azure-native-secrets-"));
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
  return { directory, key, cert };
}
export async function azureOracle() {
  const { directory, key, cert } = certificate();
  const owner = new AbortController();
  const requests: { path: string; authorized: boolean; method: string }[] = [];
  let replacement: { body: BoundaryValue; status: number } | undefined;
  let held:
    | {
        arrived: ReturnType<typeof deferred<void>>;
        closed: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", azureVault);
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const list = url.pathname === "/secrets";
      const authorized = authentic(request, url, Buffer.concat(parts).length);
      requests.push({
        path: request.url ?? "",
        authorized,
        method: request.method ?? "",
      });
      response.setHeader("content-type", "application/json");
      if (!authorized) {
        response.writeHead(401).end(JSON.stringify({ error: azureToken }));
        return;
      }
      if (held) {
        const capture = held;
        held = undefined;
        response.once("close", () => {
          capture.closed.resolve();
          capture.release.resolve();
        });
        const body = JSON.stringify(list ? azureList : azureBundle);
        response.write(body.slice(0, 1));
        capture.arrived.resolve();
        await capture.release.promise;
        if (!response.destroyed) response.end(body.slice(1));
        return;
      }
      response.writeHead(replacement?.status ?? 200);
      response.end(
        JSON.stringify(replacement?.body ?? (list ? azureList : azureBundle)),
      );
    },
  );
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const actual = tlsFetch(readFileSync(cert));
  const transport: NativeProviderTransport = {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
    supportsNativeOrigin: (origin) => origin === azureVault,
    fetch: (input, init) => {
      owner.signal.throwIfAborted();
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== azureVault) throw new Error("Unowned vault origin");
      return actual(
        new URL(url.pathname + url.search, `https://127.0.0.1:${port}`),
        request,
      );
    },
  };
  return {
    transport,
    owner,
    requests,
    reply(body: BoundaryValue, status = 200) {
      replacement = { body, status };
    },
    hold() {
      held = {
        arrived: deferred<void>(),
        closed: deferred<void>(),
        release: deferred<void>(),
      };
      return held;
    },
    async close() {
      owner.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** A physical cancellation must precede the shared HTTP15s deadline. */
export async function azureClosed(closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Azure TLS socket stayed open")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
