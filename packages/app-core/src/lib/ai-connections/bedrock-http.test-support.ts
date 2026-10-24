/** Owned HTTP/TLS with an independent Node-crypto AWS SigV4 verifier. */
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
export const BEDROCK_CREDENTIAL = {
  accessKeyId: "AKIAOWNEDTEST12345678",
  secretAccessKey: "ownedSecretAccessKey0123456789AbCdEf",
  sessionToken: "ownedSessionToken0123456789",
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
type AwsTestCredential = Omit<typeof BEDROCK_CREDENTIAL, "sessionToken"> & {
  sessionToken?: string;
};
function authenticated(
  request: IncomingMessage,
  body: string,
  credential: AwsTestCredential,
) {
  const auth =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/bedrock\/aws4_request, SignedHeaders=([a-z;-]+), Signature=([a-f0-9]{64})$/.exec(
      request.headers.authorization ?? "",
    );
  if (!auth) return false;
  const [, id, day, region, names, signature] = auth;
  if (
    id !== credential.accessKeyId ||
    !day ||
    !region ||
    !names ||
    request.headers["x-amz-security-token"] !== credential.sessionToken
  )
    return false;
  const parsedAuthority = z
    .string()
    .regex(/^[a-z0-9.-]+(?::\d+)?$/)
    .safeParse(request.headers["x-test-original-authority"]);
  if (!parsedAuthority.success) return false;
  const authority = parsedAuthority.data;
  const url = new URL(request.url ?? "/", `http://${authority}`);
  const canonicalPath = url.pathname
    .split("/")
    .map((segment) => encode(encode(decodeURIComponent(segment))))
    .join("/");
  const fields = names.split(";");
  if (
    fields.join(";") !== [...fields].sort().join(";") ||
    !fields.includes("host") ||
    !fields.includes("x-amz-date")
  )
    return false;
  const headers = `${fields
    .map(
      (name) =>
        `${name}:${name === "host" ? authority : String(request.headers[name] ?? "").trim()}`,
    )
    .join("\n")}\n`;
  const query = [...url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort()
    .map((pair) => pair.join("="))
    .join("&");
  const canonical = [
    "POST",
    canonicalPath,
    query,
    headers,
    names,
    digest(body),
  ].join("\n");
  const stamp = String(request.headers["x-amz-date"]);
  if (!stamp.startsWith(day)) return false;
  const scope = `${day}/${region}/bedrock/aws4_request`;
  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${credential.secretAccessKey}`, day), region),
      "bedrock",
    ),
    "aws4_request",
  );
  return (
    hmac(
      key,
      ["AWS4-HMAC-SHA256", stamp, scope, digest(canonical)].join("\n"),
    ).toString("hex") === signature
  );
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "bedrock-owned-tls-"));
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
    { stdio: "ignore", timeout: 10000 },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
function fixturePort(
  origin: string,
  abort: AbortController,
  fetcher: typeof fetch,
) {
  return {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    fetch: (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (
        ![
          "https://bedrock-runtime.us-east-1.amazonaws.com",
          "http://localhost:41999",
        ].includes(url.origin)
      )
        throw new Error("Unexpected AWS origin");
      const headers = new Headers(init?.headers);
      headers.set("x-test-original-authority", url.host);
      return fetcher(new URL(url.pathname + url.search, origin), {
        ...init,
        headers,
      });
    },
  };
}
export async function bedrockFixture(withSession = true, secure = false) {
  const tls = secure ? certificate() : null;
  const credential: AwsTestCredential = {
    accessKeyId: BEDROCK_CREDENTIAL.accessKeyId,
    secretAccessKey: BEDROCK_CREDENTIAL.secretAccessKey,
  };
  if (withSession) credential.sessionToken = BEDROCK_CREDENTIAL.sessionToken;
  const records: {
    path: string;
    body: string;
    authenticated: boolean;
    ended: boolean;
    closed: boolean;
  }[] = [];
  let mode = "complete";
  const receive: import("node:http").RequestListener = async (
    request,
    response,
  ) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    const record = {
      path: request.url ?? "",
      body,
      authenticated: authenticated(request, body, credential),
      ended: false,
      closed: false,
    };
    records.push(record);
    response.on("finish", () => {
      record.ended = true;
    });
    response.on("close", () => {
      record.closed = true;
    });
    response.setHeader("content-type", "application/json");
    if (!record.authenticated || mode === "unauthorized") {
      response.writeHead(401).end("{}");
      return;
    }
    if (mode === "held") {
      response.flushHeaders();
      response.write('{"output":');
      return;
    }
    if (mode === "malformed") {
      response.end("not JSON");
      return;
    }
    const text =
      mode === "echo"
        ? BEDROCK_CREDENTIAL.secretAccessKey
        : "Exact Bedrock answer.";
    response.end(
      JSON.stringify({
        output: { message: { role: "assistant", content: [{ text }] } },
        stopReason: mode === "tool-use" ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
    );
  };
  const server = tls ? createSecureServer(tls, receive) : createServer(receive);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().positive() })
    .parse(server.address());
  const origin = `${secure ? "https" : "http"}://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const port = fixturePort(origin, abort, tls ? tlsFetch(tls.cert) : fetch);
  return {
    origin,
    records,
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
      if (tls) rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
