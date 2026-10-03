// A stub of the daemon's fill routes (`crates/daemon/src/fill`), on the port
// the extension is built to call. It applies the daemon's own admission rules
// in the daemon's own order (`daemon-admission.mjs`), because the extension is
// only proven against a server that refuses what the real one refuses:
//
//   plugin gate       404, no body, every method, every path
//   admission         loopback, extension origin, pairing token
//   exact origin      an entry answers only for the origin its `url:` names
//
// Rate limiting is left to the daemon's own Rust tests. Nothing here logs a
// value: the request log carries the route, the status and the facts the
// daemon decides on, never a reply body.
import http from "node:http";
import * as z from "zod";
import { createAdmission, refuse, reply } from "./daemon-admission.mjs";

/** The port `ENDPOINTS.daemon.default` (packages/os-domain) gives the extension. */
export const DAEMON_PORT = 18790;

// The bodies the daemon's routes accept, and nothing else.
const matchBody = z.strictObject({ origin: z.string() });
const fillBody = z.strictObject({
  reference: z.string(),
  origin: z.string(),
  field: z.enum(["password", "username"]),
});

/** The canonical origin `location.origin` would give, or null. */
function canonicalOrigin(raw) {
  try {
    const url = new URL(raw);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ entries: { name: string, url: string, login: string, secret: string }[] }} options
 */
export async function startDaemonStub({ entries }) {
  const state = {
    /** The `browser-autofill` plugin switch. Off answers as a path never served. */
    pluginActive: true,
    /** Milliseconds a value-bearing answer is held, to let a page change under it. */
    fillDelayMs: 0,
  };
  const admission = createAdmission();
  const log = [];
  let inflight = 0;

  // An entry declares a URL, which may carry a path; its origin is what counts.
  const declaring = (origin) =>
    entries.filter((entry) => new URL(entry.url).origin === origin);

  async function match(req, res) {
    if (!admission.pairedCaller(req, res)) return null;
    const asked = matchBody.safeParse(await readJson(req));
    if (!asked.success) return refuse(res, 400, "invalid_request");
    const origin = canonicalOrigin(asked.data.origin);
    if (!origin) return refuse(res, 400, "invalid_origin");
    const references = declaring(origin).map((entry) => entry.name);
    reply(res, 200, { references, truncated: false });
    return null;
  }

  async function fill(req, res) {
    if (!admission.pairedCaller(req, res)) return null;
    const asked = fillBody.safeParse(await readJson(req));
    if (!asked.success) return refuse(res, 400, "invalid_request");
    const { reference, field } = asked.data;
    const origin = canonicalOrigin(asked.data.origin);
    if (!origin) return refuse(res, 400, "invalid_origin");
    // A reference for another site answers exactly like one that is absent.
    const entry = declaring(origin).find((one) => one.name === reference);
    if (!entry) return refuse(res, 404, "no_match");
    inflight++;
    await later(state.fillDelayMs);
    inflight--;
    const value = field === "password" ? entry.secret : entry.login;
    reply(res, 200, { field, value });
    return { reference, origin, field };
  }

  const routes = {
    "/v1/fill": fill,
    "/v1/fill/match": match,
    "/v1/fill/pair": async (req, res) => admission.pair(req, res),
  };

  const server = http.createServer(async (req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    // The plugin gate wraps every method of every fill path.
    if (!state.pluginActive || !route || req.method !== "POST") {
      reply(res, 404);
      log.push({ path: req.url, status: 404 });
      return;
    }
    const seen = await route(req, res);
    log.push({
      path: req.url,
      status: res.statusCode,
      origin: req.headers.origin,
      host: req.headers.host,
      ...seen,
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", (cause) =>
      reject(
        new Error(
          `the stub daemon needs 127.0.0.1:${DAEMON_PORT}, which the extension is built to call (${cause.code})`,
        ),
      ),
    );
    server.listen(DAEMON_PORT, "127.0.0.1", resolve);
  });

  return {
    state,
    log,
    approve: admission.approve,
    isPaired: admission.isPaired,
    /** Value requests the daemon is holding for `fillDelayMs`. */
    pendingFills: () => inflight,
    /** Requests that reached the value route, with the facts it decided on. */
    fills: () => log.filter((row) => row.path === "/v1/fill"),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
