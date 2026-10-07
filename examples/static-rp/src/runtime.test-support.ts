import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { expect, vi } from "vitest";

const signer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherSigner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const observed = {
  issuer: "",
  navigations: new Array<string>(),
  requests: new Array<{
    path: string | undefined;
    method: string | undefined;
    body: string;
    authorization: string | undefined;
    cookie: string | undefined;
  }>(),
  nonce: "",
  tokenStatus: 200,
  wrongSignature: false,
  jwksRedirect: false,
};

let server: Server | undefined;

function signedToken() {
  const authorization = new URL(observed.navigations[0] ?? "");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "controlled" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: observed.issuer,
      aud: authorization.searchParams.get("client_id"),
      sub: "controlled-rp-subject",
      nonce: observed.nonce || authorization.searchParams.get("nonce"),
      iat: now,
      exp: now + 120,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: (observed.wrongSignature ? otherSigner : signer).privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

function issuerResponse(
  response: import("node:http").ServerResponse,
  path: string | undefined,
) {
  if (path === "/jwks" && observed.jwksRedirect) {
    response.writeHead(302, { location: `${observed.issuer}/unexpected` });
    response.end();
    return;
  }
  const status = path === "/token" ? observed.tokenStatus : 200;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify(
      path === "/token"
        ? status === 200
          ? { id_token: signedToken() }
          : { error: "invalid_grant" }
        : {
            keys: [
              {
                ...signer.publicKey.export({ format: "jwk" }),
                kid: "controlled",
                alg: "ES256",
              },
            ],
          },
    ),
  );
}

function controlledIssuer() {
  return createServer({}, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      observed.requests.push({
        path: request.url,
        method: request.method,
        body,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      issuerResponse(response, request.url);
    });
  });
}

export function render(page: "index.html" | "opensesame/callback.html") {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public", page), "utf8"),
    "text/html",
  ).body.innerHTML;
}

export async function startRuntime() {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  observed.navigations = [];
  observed.requests = [];
  observed.nonce = "";
  observed.tokenStatus = 200;
  observed.wrongSignature = false;
  observed.jwksRedirect = false;
  const browser = window;
  browser.sessionStorage.clear();
  browser.history.replaceState(null, "", "/");
  // Only navigation is captured; DOM, location reads and sealed storage are real.
  const location = {
    get origin() {
      return browser.location.origin;
    },
    get href() {
      return browser.location.href;
    },
    get search() {
      return browser.location.search;
    },
    get hash() {
      return browser.location.hash;
    },
    assign(href: string) {
      observed.navigations.push(href);
    },
  };
  vi.stubGlobal(
    "window",
    new Proxy(browser, {
      get(target, property) {
        switch (property) {
          case "location":
            return location;
          case "sessionStorage":
            return target.sessionStorage;
          case "history":
            return target.history;
          case "document":
            return target.document;
          default:
            throw new Error("Unsupported controlled browser port.");
        }
      },
    }),
  );
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  // The existing origin-key port supplies a real nonextractable key, not an auth verdict.
  const { useClientAtRestKeys } = await import("@opensesame/browser-at-rest");
  useClientAtRestKeys(async () => key);
  server = controlledIssuer();
  const current = server;
  await new Promise<void>((resolve) => current.listen(0, "127.0.0.1", resolve));
  const address = current.address();
  if (
    !(address instanceof Object) ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.address !== "127.0.0.1"
  ) {
    throw new Error("Controlled issuer did not bind a TCP port.");
  }
  observed.issuer = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("__OPENSESAME_ISSUER__", observed.issuer);
  render("index.html");
}

export async function stopRuntime() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const current = server;
  server = undefined;
  if (current === undefined) return;
  current.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    current.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function begin() {
  await import("../public/index.js");
  const button = document.querySelector<HTMLButtonElement>("#sign-in");
  if (button === null) throw new Error("Sign-in button missing.");
  button.click();
  await vi.waitFor(() => expect(observed.navigations).toHaveLength(1));
  return new URL(observed.navigations[0] ?? "");
}

export function callback(authorization: URL) {
  const url = new URL("/opensesame/callback", window.location.origin);
  url.search = new URLSearchParams({
    code: "controlled-one-use-code",
    state: authorization.searchParams.get("state") ?? "",
    iss: observed.issuer,
  }).toString();
  window.history.replaceState(null, "", url.href);
  render("opensesame/callback.html");
  return url;
}
