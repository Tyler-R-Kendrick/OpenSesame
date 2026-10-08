// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ObservedRequest = {
  method: string | undefined;
  path: string | undefined;
  body: string;
  authorization: string | undefined;
  cookie: string | undefined;
};

let server: Server | undefined;
let origin: string;
let requests: ObservedRequest[];
let responseStatus: number;

beforeEach(async () => {
  server = undefined;
  vi.resetModules();
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "index.html"), "utf8"),
    "text/html",
  ).body.innerHTML;
  requests = [];
  responseStatus = 200;
  const currentServer = createServer({}, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      response.writeHead(responseStatus, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          responseStatus === 200
            ? { id: "anonymous-test-identity" }
            : { error: "registration_refused" },
        ),
      );
    });
  });
  server = currentServer;
  await new Promise<void>((resolve) =>
    currentServer.listen(0, "127.0.0.1", resolve),
  );
  const address = currentServer.address();
  if (
    !(address instanceof Object) ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535 ||
    address.address !== "127.0.0.1"
  ) {
    throw new Error("The controlled registration server did not bind.");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  const currentServer = server;
  if (currentServer === undefined) return;
  currentServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    currentServer.close((error) => (error ? reject(error) : resolve()));
  });
});

function input() {
  const issuer = document.querySelector<HTMLInputElement>("#issuer");
  const button = document.querySelector<HTMLButtonElement>("#register");
  if (issuer === null || button === null)
    throw new Error("Registration controls missing.");
  return { issuer, button };
}

describe("static anonymous registration runtime", () => {
  it("sends the real anonymous request and renders the controlled response", async () => {
    const { issuer, button } = input();
    issuer.value = `${origin}///`;
    await import("./main.js");
    button.click();
    expect(document.querySelector("#out")?.textContent).toBe("registering…");
    await vi.waitFor(() =>
      expect(document.querySelector("#out")?.textContent).toBe(
        '{\n  "id": "anonymous-test-identity"\n}',
      ),
    );
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/agent/identity",
        body: '{"type":"anonymous"}',
        authorization: undefined,
        cookie: undefined,
      },
    ]);
  });

  it("renders a real anonymous-registration refusal", async () => {
    responseStatus = 403;
    const { issuer, button } = input();
    issuer.value = origin;
    await import("./main.js");
    button.click();
    await vi.waitFor(() =>
      expect(document.querySelector("#out")?.textContent).toBe(
        '{\n  "error": "registration_refused"\n}',
      ),
    );
    expect(requests[0]).toMatchObject({
      body: '{"type":"anonymous"}',
      authorization: undefined,
      cookie: undefined,
    });
    expect(requests).toHaveLength(1);
  });

  it("does not register when the registration control is absent", async () => {
    document.querySelector("#register")?.remove();
    await import("./main.js");
    document.body.click();
    expect(requests).toEqual([]);
  });
});

describe("static registration optional controls", () => {
  it("uses the browser origin-relative request when the issuer control is absent", async () => {
    const { button } = input();
    document.querySelector("#issuer")?.remove();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      expect(url).toBe("/agent/identity");
      // Node fetch needs the explicit origin that browser fetch supplies.
      return realFetch(new URL(String(url), origin).href, options);
    });
    await import("./main.js");
    button.click();
    await vi.waitFor(() =>
      expect(document.querySelector("#out")?.textContent).toContain(
        "anonymous-test-identity",
      ),
    );
    expect(requests[0]?.body).toBe('{"type":"anonymous"}');
  });

  it("keeps registration available when only the optional output is absent", async () => {
    const realFetch = globalThis.fetch;
    let finishParsing = () => {};
    const parsed = new Promise<void>((resolve) => {
      finishParsing = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await realFetch(...args);
      const realJson = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(async () => {
        const body = await realJson();
        finishParsing();
        return body;
      });
      return response;
    });
    const { issuer, button } = input();
    issuer.value = origin;
    document.querySelector("#out")?.remove();
    await import("./main.js");
    button.click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await parsed;
    expect(requests[0]?.body).toBe('{"type":"anonymous"}');
  });
});
