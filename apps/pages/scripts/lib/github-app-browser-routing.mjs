/** Request-boundary bridge only: browser fixed HTTPS URLs -> independent loopback HTTP fixture. */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

function providerRequest(target, browserRequest, headers, signal) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method: browserRequest.method(),
      headers,
      signal,
    });
    request.setTimeout(20000, () =>
      request.destroy(new Error("Provider socket deadline")),
    );
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1048576)
          request.destroy(
            new Error("Provider response exceeded fixture bound"),
          );
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () =>
        reject(new Error("Provider response ended early")),
      );
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 500,
          headers: Object.fromEntries(
            Object.entries(response.headers)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : String(value),
              ]),
          ),
          body: Buffer.concat(chunks),
        }),
      );
    });
    const body = browserRequest.postDataBuffer();
    if (body && body.length > 1048576)
      request.destroy(new Error("Provider request exceeded fixture bound"));
    else request.end(body ?? undefined);
  });
}

export async function routeGithubProvider(
  context,
  fixture,
  { origin, record },
) {
  const live = new Map();
  const rows = [];
  const errors = [];
  const unexpected = [];
  const failed = (request) => live.get(request)?.abort();
  context.on("requestfailed", failed);
  context.on("close", () => {
    for (const controller of live.values()) controller.abort();
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === "blob:" || url.protocol === "data:")
      return route.fallback();
    if (url.origin === origin) {
      if (!url.pathname.includes("/api/")) return route.continue();
      unexpected.push(`app-backend ${request.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    const lane =
      url.origin === "https://api.github.com"
        ? "api"
        : url.origin === "https://github.com"
          ? "site"
          : null;
    if (!lane) {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    const controller = new AbortController();
    live.set(request, controller);
    const row = {
      lane,
      method: request.method(),
      path: url.pathname.replace(
        /\/app-manifests\/[^/]+\//,
        "/app-manifests/[code]/",
      ),
      status: null,
      cancelled: false,
    };
    rows.push(row);
    try {
      const headers = Object.fromEntries(
        Object.entries(await request.allHeaders()).filter(
          ([name]) => name !== "content-length" && name !== "accept-encoding",
        ),
      );
      headers.host = url.host;
      const target = `${fixture.endpoint}/${lane}${url.pathname}${url.search}`;
      const response = await providerRequest(
        target,
        request,
        headers,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      row.status = response.status;
      // Node fetch does not stand in for browser trust. Fixture headers are
      // delivered to the original fixed-origin request, without changing its URL.
      for (const name of ["transfer-encoding", "connection", "content-length"])
        delete response.headers[name];
      await route.fulfill(response);
    } catch {
      if (controller.signal.aborted || request.failure()) row.cancelled = true;
      else {
        errors.push(`Provider socket bridge failed: ${row.method} ${row.path}`);
        await route.abort("connectionfailed").catch(() => {});
      }
    } finally {
      live.delete(request);
      record(
        row.cancelled ? "provider-cancel" : "provider-socket",
        `${row.method} ${row.path} ${row.status ?? "cancelled"}`,
      );
    }
  });
  return routingLifecycle(context, live, failed, rows, errors, unexpected);
}

function routingLifecycle(context, live, failed, rows, errors, unexpected) {
  return {
    rows,
    errors,
    unexpected,
    assertClean() {
      assert.equal(
        errors.length,
        0,
        "No unclassified provider bridge failures",
      );
      assert.equal(
        unexpected.length,
        0,
        "No app backend, relay or unreviewed external request",
      );
    },
    close() {
      context.off("requestfailed", failed);
      for (const controller of live.values()) controller.abort();
      // Keep every routing refusal installed until the owning context closes.
      // Removing it first would briefly let background jobs reach live GitHub.
    },
  };
}
