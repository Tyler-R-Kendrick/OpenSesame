/** Independent Snowflake SQL API oracle over real owned CA-verified TLS. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { deferred } from "./secret-backends/runtime.test-support.js";

export const snowflakeAccount =
  "https://organization-account.snowflakecomputing.com";
export const snowflakeToken = "controlled-snowflake/read-only~token";
export const snowflakeHandle = "019c06a4-0000-df4f-0000-00100006589e";
export const snowflakeData = {
  code: "090001",
  sqlState: "00000",
  statementHandle: snowflakeHandle,
  statementStatusUrl: "https://untrusted.example/never-follow",
  resultSetMetaData: {
    numRows: 2,
    format: "jsonv2",
    rowType: [
      { name: "kind", type: "text" },
      { name: "name", type: "text" },
      { name: "created_on", type: "timestamp_ltz" },
      { name: "database_name", type: "text" },
      { name: "schema_name", type: "text" },
    ],
    partitionInfo: [{ rowCount: 2, uncompressedSize: 120 }],
  },
  data: [
    [null, "ANALYTICS", "1700000000000000000", null, null],
    [null, "WAREHOUSE_METADATA", "1700000000000000001", null, null],
  ],
};
export const snowflakePending = {
  code: "333334",
  statementHandle: snowflakeHandle,
  statementStatusUrl: "https://untrusted.example/never-follow",
};
export function snowflakeDraft(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  return {
    providerId: "snowflake",
    displayName: "Read-only databases",
    parameters: {
      account_url: snowflakeAccount,
      token_type: mode,
      role: "READER",
    },
    credentials: { token: snowflakeToken },
  };
}
type Handler = (request: IncomingMessage, response: ServerResponse) => void;
function hasExpectedHeaders(request: IncomingMessage, mode: string) {
  return (
    request.headers.authorization === `Bearer ${snowflakeToken}` &&
    request.headers["x-snowflake-authorization-token-type"] === mode &&
    request.headers.accept === "application/json" &&
    request.headers["content-type"] === "application/json" &&
    request.headers["user-agent"] === "OpenSesame/1.0" &&
    request.headers.cookie === undefined
  );
}
function validStatementBody(method: string | undefined, body: string) {
  let validBody = method === "GET" && body === "";
  if (method === "POST") {
    try {
      validBody = z
        .object({
          statement: z.literal("SHOW TERSE DATABASES LIMIT 20"),
          timeout: z.literal(15),
          role: z.literal("READER"),
        })
        .strict()
        .safeParse(JSON.parse(body)).success;
    } catch {
      validBody = false;
    }
  }
  return validBody;
}
function validStatementRoute(
  method: string | undefined,
  url: URL,
  ids: Set<string>,
) {
  const requestId = url.searchParams.get("requestId") ?? "";
  const route =
    method === "POST"
      ? url.pathname === "/api/v2/statements" &&
        url.searchParams.size === 1 &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId) &&
        !ids.has(requestId)
      : method === "GET" &&
        url.pathname === `/api/v2/statements/${snowflakeHandle}` &&
        (url.searchParams.size === 0 ||
          (url.searchParams.size === 1 &&
            /^[1-9][0-9]?$/.test(url.searchParams.get("partition") ?? "")));
  return { route, requestId };
}
function oracleTransport(
  owner: AbortController,
  origins: string[],
  port: number,
  cert: Buffer,
): NativeProviderTransport {
  const actualTLS = tlsFetch(cert);
  const transport: NativeProviderTransport = {
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
    supportsNativeOrigin: (origin) => origin === snowflakeAccount,
    fetch: async (input, init) => {
      owner.signal.throwIfAborted();
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== snowflakeAccount)
        throw new Error("Oracle rejected a changed Snowflake account");
      const outgoing: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.any([owner.signal, request.signal]),
      };
      if (request.method !== "GET") outgoing.body = await request.arrayBuffer();
      owner.signal.throwIfAborted();
      outgoing.signal?.throwIfAborted();
      origins.push(url.origin);
      return actualTLS(
        new URL(url.pathname + url.search, `https://127.0.0.1:${port}`),
        outgoing,
      );
    },
  };
  return transport;
}
function oracleCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "snowflake-sql-"));
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
export async function snowflakeOracle(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  const { directory, key, cert } = oracleCertificate();
  const owner = new AbortController();
  const requests: {
    path: string;
    method: string;
    body: string;
    authorized: boolean;
  }[] = [];
  const origins: string[] = [];
  const ids = new Set<string>();
  let handler: Handler = (_request, response) =>
    response.end(JSON.stringify(snowflakeData));
  let held:
    | {
        method: string;
        arrived: ReturnType<typeof deferred<void>>;
        closed: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const url = new URL(request.url ?? "/", "https://oracle.test");
      const validBody = validStatementBody(request.method, body);
      const { route, requestId } = validStatementRoute(
        request.method,
        url,
        ids,
      );
      if (requestId) ids.add(requestId);
      const authorized =
        route && validBody && hasExpectedHeaders(request, mode);
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "",
        body,
        authorized,
      });
      response.setHeader("content-type", "application/json");
      if (!authorized) {
        response.writeHead(401);
        response.end(JSON.stringify({ error: snowflakeToken }));
        return;
      }
      if (held && held.method === request.method) {
        const hold = held;
        held = undefined;
        response.once("close", () => hold.closed.resolve());
        response.writeHead(200);
        response.write('{"code":');
        hold.arrived.resolve();
        return;
      }
      handler(request, response);
    },
  );
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const transport = oracleTransport(owner, origins, port, readFileSync(cert));
  return {
    transport,
    owner,
    requests,
    origins,
    reply(write: Handler) {
      handler = write;
    },
    hold(method = "POST") {
      const hold = {
        method,
        arrived: deferred<void>(),
        closed: deferred<void>(),
      };
      held = hold;
      return hold;
    },
    async close() {
      owner.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const malformedSnowflakeReplies = [
  {},
  { ...snowflakeData, code: "391908" },
  { ...snowflakeData, error: "denied" },
  { ...snowflakeData, sqlState: "42000" },
  { ...snowflakeData, statementHandle: "../../foreign" },
  {
    ...snowflakeData,
    resultSetMetaData: { ...snowflakeData.resultSetMetaData, numRows: 21 },
  },
  {
    ...snowflakeData,
    resultSetMetaData: { ...snowflakeData.resultSetMetaData, format: "csv" },
  },
  { ...snowflakeData, data: [snowflakeData.data[0]] },
  { ...snowflakeData, data: [snowflakeData.data[0], snowflakeData.data[0]] },
  {
    ...snowflakeData,
    data: [[null, snowflakeToken, "0", null, null], snowflakeData.data[1]],
  },
  {
    ...snowflakeData,
    data: [[null, "bad\nname", "0", null, null], snowflakeData.data[1]],
  },
  {
    ...snowflakeData,
    data: [["not-null", "WRONG_QUERY", "0", null, null], snowflakeData.data[1]],
  },
].map((body) => ({ body }));

export const expectedSnowflakeDatabases = {
  label: "Showing 2 databases from first page",
  items: [
    { id: "ANALYTICS", label: "ANALYTICS" },
    { id: "WAREHOUSE_METADATA", label: "WAREHOUSE_METADATA" },
  ],
};

export const invalidSnowflakeAccounts = [
  "http://account.snowflakecomputing.com",
  "https://account.snowflakecomputing.com.evil.test",
  "https://user:pass@account.snowflakecomputing.com",
  "https://account.snowflakecomputing.com/?token=secret",
  "https://account.snowflakecomputing.com/path",
];
