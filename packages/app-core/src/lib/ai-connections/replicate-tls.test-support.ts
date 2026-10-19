/** Independently owned TLS prediction service; no client request/response builders reused. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import type { AiConnectionTransport } from "./types.js";
export const REPLICATE_TOKEN = "r8_owned_primary_operation_token";
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "replicate-primary-tls-"));
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error("Owned TLS parent must be a regular directory");
    if (ancestor === "/") break;
  }
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
export type PredictionExchange = {
  path: string;
  method: string;
  body: string;
  authorization: string;
  ended: boolean;
  closed: boolean;
};
type ServiceState = {
  mode: string;
  pollsBeforeSuccess: number;
  onTerminal?: () => void;
};
type Job = { id: string; status: string };
async function captureExchange(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 65536) throw new Error("Owned request body exceeded limit");
    parts.push(Buffer.from(part));
  }
  const row = {
    path: request.url ?? "",
    method: request.method ?? "",
    body: Buffer.concat(parts).toString(),
    authorization: request.headers.authorization ?? "",
    ended: false,
    closed: false,
  };
  response.on("finish", () => {
    row.ended = true;
  });
  response.on("close", () => {
    row.closed = true;
  });
  return row;
}
function createJob(row: PredictionExchange, jobs: Map<string, number>): Job {
  z.object({
    input: z.record(z.string(), z.json()),
    version: z.string().optional(),
  })
    .strict()
    .parse(JSON.parse(row.body));
  const id = `owned-${jobs.size + 1}`;
  jobs.set(id, 0);
  return { id, status: "starting" };
}
function transitionJob(
  row: PredictionExchange,
  path: string,
  jobs: Map<string, number>,
  state: ServiceState,
): Job {
  if (
    row.method === "POST" &&
    (path === "/predictions" ||
      /^\/models\/[^/]+\/[^/]+\/predictions$/.test(path))
  )
    return createJob(row, jobs);
  const match = /^\/predictions\/([A-Za-z0-9_-]+)(\/cancel)?$/.exec(path);
  const id = match?.[1] ?? "";
  if (!jobs.has(id)) throw new Error("Unknown prediction");
  if (match?.[2] && row.method === "POST") return { id, status: "canceled" };
  if (row.method !== "GET") throw new Error("Unsupported operation");
  const polls = (jobs.get(id) ?? 0) + 1;
  jobs.set(id, polls);
  return {
    id,
    status: polls <= state.pollsBeforeSuccess ? "processing" : "succeeded",
  };
}
function finishPrediction(
  row: PredictionExchange,
  response: ServerResponse,
  job: Job,
  state: ServiceState,
  held: () => void,
) {
  if (state.mode === "held" && row.method === "GET") {
    response.flushHeaders();
    response.write('{"id":');
    held();
    return;
  }
  const id =
    state.mode === "wrong-id" && row.method === "GET" ? "foreign-job" : job.id;
  const status =
    state.mode === "failed" && row.method === "GET" ? "failed" : job.status;
  let output: object | string | null = null;
  if (status === "succeeded" && state.mode !== "empty")
    output =
      state.mode === "echo"
        ? REPLICATE_TOKEN
        : {
            text: "Independently produced prediction.",
            asset: "https://untrusted.example/generated.png",
          };
  response.end(
    JSON.stringify({
      id,
      status,
      output,
      urls: {
        get: "https://untrusted.example/stolen-job",
        cancel: "https://untrusted.example/cancel",
      },
    }),
  );
  if (status === "succeeded") state.onTerminal?.();
}
function predictionService(
  prefix: string,
  requests: PredictionExchange[],
  state: ServiceState,
  held: () => void,
) {
  const jobs = new Map<string, number>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const row = await captureExchange(request, response);
      requests.push(row);
      response.setHeader("content-type", "application/json");
      if (
        row.authorization !== `Bearer ${REPLICATE_TOKEN}` ||
        ["unauthorized", "forbidden"].includes(state.mode)
      ) {
        response.writeHead(state.mode === "forbidden" ? 403 : 401).end("{}");
        return;
      }
      const job = transitionJob(
        row,
        row.path.slice(prefix.length),
        jobs,
        state,
      );
      finishPrediction(row, response, job, state, held);
    } catch {
      response.writeHead(400).end("{}");
    }
  };
}
export async function replicateTlsFixture(
  baseUrl = "https://api.replicate.com/v1",
) {
  const tls = certificate();
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const requests: PredictionExchange[] = [];
  const sockets = new Set<Duplex>();
  const state: ServiceState = { mode: "complete", pollsBeforeSuccess: 1 };
  let resolveHeld = () => {};
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const server = createServer(
    tls,
    predictionService(prefix, requests, state, resolveHeld),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const fetcher = tlsFetch(tls.cert);
  const port: AiConnectionTransport = {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    fetch: (input, init) => {
      const url = new URL(input);
      if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`))
        throw new Error("Unowned prediction target");
      return fetcher(new URL(url.pathname + url.search, origin), init);
    },
  };
  return {
    baseUrl,
    origin,
    requests,
    held,
    state,
    port,
    abort,
    async close() {
      abort.abort();
      const stopped = once(server, "close");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      if (sockets.size) throw new Error("Owned TLS sockets remain");
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
