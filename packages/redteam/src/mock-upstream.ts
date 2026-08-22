/**
 * A tiny, per-call stub HTTP server standing in for the Host API / daemon that
 * `apps/mcp-host` talks to (`hostFetch/daemonFetch` in `apps/mcp-host/src/host-api.ts`).
 *
 * Each red-team test case that needs one gets its own instance on an
 * OS-assigned free port (`listen(0, ...)`), started and torn down inside a
 * single `callApi()` invocation — no fixed ports, no cross-test interference,
 * safe to run tests in parallel. This is what lets the confused-deputy,
 * credential-exfiltration, and malformed-input test classes hand the real,
 * unmodified `apps/mcp-host` server whatever upstream body a case wants to
 * probe it with.
 *
 * (The prompt-injection class needs something different — a single stub the
 * *model* interacts with across a whole eval run, on the fixed default ports
 * `apps/mcp-host` assumes when no override is configured — see
 * `scripts/mock-upstream-daemon.mjs`.)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRoute {
  /** Path to match, or a prefix ending in "*" (e.g. "/api/v1/tasks/*"). */
  path: string;
  /** HTTP method to match; omit to match any method. */
  method?: string;
  /** Status code to answer with. Defaults to 200. */
  status?: number;
  /** JSON body to answer with. */
  body: unknown;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockUpstream {
  /** Base URL of the stub, suitable for OPENSESAME_SERVER / OPENSESAME_DAEMON_URL. */
  url: string;
  /** Every request the stub received, in order, for assertions to inspect. */
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function isAddressInfo(
  address: AddressInfo | string | null,
): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

function matchRoute(
  routes: MockRoute[],
  method: string,
  url: string,
): MockRoute | undefined {
  const path = url.split("?")[0] ?? url;
  return routes.find((route) => {
    const methodOk =
      !route.method || route.method.toUpperCase() === method.toUpperCase();
    const pathOk = route.path.endsWith("*")
      ? path.startsWith(route.path.slice(0, -1))
      : path === route.path;
    return methodOk && pathOk;
  });
}

export async function startMockUpstream(
  routes: MockRoute[],
): Promise<MockUpstream> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      requests.push({ method, url, headers: req.headers, body });

      const match = matchRoute(routes, method, url);
      const status = match?.status ?? (match ? 200 : 404);
      const payload = match
        ? match.body
        : { error: "mock_upstream_no_route", method, url };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("mock upstream failed to bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
