import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
/** Verified TLS plus independent verification of the existing GCP signer's JWT. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { base64ToBytes } from "../native-base64.js";
import { EMAIL, gcpPublicKey } from "../native-gcp.test-support.js";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import { ownBytes } from "@opensesame/os-domain";
export const TOKEN = "ya29.owned-vertex-token-0123456789";
function segment(value: string): Uint8Array<ArrayBuffer> {
  return ownBytes(base64ToBytes(
    value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  ));
}
async function validAssertion(body: string): Promise<boolean> {
  const fields = new URLSearchParams(body);
  const [header, claims, signature] = (fields.get("assertion") ?? "").split(
    ".",
  );
  if (
    !header ||
    !claims ||
    !signature ||
    fields.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
  )
    return false;
  const parsed = z
    .object({
      iss: z.literal(EMAIL),
      scope: z.literal("https://www.googleapis.com/auth/cloud-platform"),
      aud: z.literal("https://oauth2.googleapis.com/token"),
      iat: z.number().int(),
      exp: z.number().int(),
    })
    .strict()
    .safeParse(JSON.parse(new TextDecoder().decode(segment(claims))));
  if (
    !parsed.success ||
    parsed.data.exp - parsed.data.iat !== 3600 ||
    Math.abs(Date.now() / 1000 - parsed.data.iat) > 5
  )
    return false;
  const algorithm = JSON.parse(new TextDecoder().decode(segment(header)));
  if (algorithm.alg !== "RS256") return false;
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    gcpPublicKey(),
    segment(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
}
type VertexRecord = {
  path: string;
  body: string;
  authenticated: boolean;
  ended: boolean;
  closed: boolean;
};
function vertexHandler(
  records: VertexRecord[],
  faults: string[],
  readMode: () => string,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    const record = {
      path: request.url ?? "",
      body,
      authenticated: false,
      ended: false,
      closed: false,
    };
    records.push(record);
    response.on("close", () => {
      record.closed = true;
    });
    response.on("finish", () => {
      record.ended = true;
    });
    response.setHeader("content-type", "application/json");
    if (record.path === "/token") {
      try {
        record.authenticated = await validAssertion(body);
      } catch {
        faults.push("invalid-token-assertion");
      }
      if (!record.authenticated) {
        response.writeHead(401).end("{}");
        return;
      }
      if (readMode() === "hold-token") {
        response.flushHeaders();
        return;
      }
      response.end(
        JSON.stringify({
          access_token: TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }
    record.authenticated = request.headers.authorization === `Bearer ${TOKEN}`;
    if (!record.authenticated || readMode() === "unauthorized") {
      response.writeHead(401).end("{}");
      return;
    }
    if (readMode() === "held") {
      response.flushHeaders();
      response.write('{"candidates":[');
      return;
    }
    if (readMode() === "malformed") {
      response.end("not JSON");
      return;
    }
    const text = readMode() === "echo" ? TOKEN : "Exact Vertex answer.";
    response.end(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    );
  };
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "vertex-tls-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
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
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    return { directory, key: readFileSync(key), cert: readFileSync(cert) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function vertexFixture() {
  const records: VertexRecord[] = [];
  const faults: string[] = [];
  let mode = "complete";
  const tls = certificate();
  const secureFetch = tlsFetch(tls.cert);
  const server = createServer(
    tls,
    vertexHandler(records, faults, () => mode),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const port = {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const token = url.href === "https://oauth2.googleapis.com/token";
      if (
        !token &&
        ![
          "https://us-central1-aiplatform.googleapis.com",
          "https://aiplatform.googleapis.com",
          "http://localhost:41999",
        ].includes(url.origin)
      )
        throw new Error("Unexpected cloud origin");
      return secureFetch(new URL(url.pathname + url.search, origin), init);
    },
  };
  return {
    records,
    faults,
    port,
    abort,
    setMode(value: string) {
      mode = value;
    },
    async close() {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
