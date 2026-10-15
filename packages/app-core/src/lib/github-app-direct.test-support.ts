import { generateKeyPairSync } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { z } from "zod";
import type { GithubDirectTransport } from "./github-app-direct.js";

export const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const credentials = {
  appId: "Iv1.test-client",
  privateKey: keyPair.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString(),
};
export type GithubRequest = {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
};

export async function githubFixture(
  reply: (request: GithubRequest, response: ServerResponse) => void,
) {
  const requests: GithubRequest[] = [];
  const lifetime = new AbortController();
  let current = true;
  const server = createServer((req, response) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const request = {
        path: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      };
      requests.push(request);
      reply(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const transport: GithubDirectTransport = {
    signal: lifetime.signal,
    assertCurrent() {
      if (!current)
        throw new Error("Captured vault or capability is no longer current");
    },
    fetch(input, init) {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com")
        throw new Error("Unexpected API origin");
      return fetch(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        init,
      );
    },
  };
  return {
    transport,
    requests,
    lifetime,
    revoke() {
      current = false;
    },
    async close() {
      lifetime.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function tokenReply(response: ServerResponse): void {
  response.end(
    JSON.stringify({
      token: "ghs_fixture_ephemeral",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
}
