/** Original browser SDK verification, actual TLS/JWKS and unchanged namespace controls. */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  checkOidcNamespaceSource,
  oidcNamespaceOption,
  readOidcNamespaceInputs,
  vercelOidcNamespace,
} from "./vercel-oidc-namespace.mjs";

const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const owner = createRequire(resolve(root, "package.json"));
const { build } = await import(
  pathToFileURL(
    resolve(dirname(owner.resolve("vite/package.json")), "dist/node/index.js"),
  ).href
);
const inputs = readOidcNamespaceInputs(root);
const scratch = mkdtempSync(join(tmpdir(), "oidc-namespace-tls-"));
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "owned-key",
  use: "sig",
  alg: "RS256",
};
const options = {
  projectId: "owned-project",
  environment: "preview",
  audience: "owned-audience",
};
const compiled = {};
let server;
let cert;
let port;
let requests = 0;

async function compile(candidate) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: candidate ? [vercelOidcNamespace(root)] : [],
    build: {
      write: false,
      minify: false,
      target: ["es2022", "chrome100", "firefox100", "safari15"],
      lib: { entry: inputs.browser, name: "originalOidc", formats: ["iife"] },
    },
  });
  return [result]
    .flat()
    .flatMap((output) => output.output)
    .find((output) => output.type === "chunk" && output.isEntry).code;
}

beforeAll(async () => {
  const keyPath = join(scratch, "key.pem");
  const certPath = join(scratch, "cert.pem");
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
      "/CN=oidc.vercel.com",
      "-addext",
      "subjectAltName=DNS:oidc.vercel.com",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(certPath);
  server = createServer(
    { key: readFileSync(keyPath), cert },
    (incoming, response) => {
      requests++;
      if (
        incoming.method !== "GET" ||
        incoming.url !== "/.well-known/jwks" ||
        incoming.headers.host !== "oidc.vercel.com"
      ) {
        response.writeHead(400).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    },
  );
  await once(server.listen(0, "127.0.0.1"), "listening");
  port = server.address().port;
  compiled.original = await compile(false);
  compiled.candidate = await compile(true);
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** Node fetch's dispatcher performs real TLS, keeping the requested origin/Host intact. */
const dispatcher = {
  dispatch(configuration, handler) {
    if (
      String(configuration.origin) !== "https://oidc.vercel.com" ||
      configuration.path !== "/.well-known/jwks"
    ) {
      handler.onError(new Error("Unowned verifier destination"));
      return false;
    }
    const headers = { Host: "oidc.vercel.com" };
    for (let index = 0; index < configuration.headers.length; index += 2) {
      const name = configuration.headers[index];
      if (name.toLowerCase() !== "host")
        headers[name] = configuration.headers[index + 1];
    }
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: configuration.path,
        method: configuration.method,
        servername: "oidc.vercel.com",
        ca: cert,
        headers,
      },
      (response) => {
        const resume = () => response.resume();
        handler.onHeaders(
          response.statusCode,
          response.rawHeaders,
          resume,
          response.statusMessage,
        );
        response.on("data", (chunk) => {
          if (!handler.onData(chunk)) response.pause();
        });
        response.on("end", () => handler.onComplete([]));
        response.on("error", (error) => handler.onError(error));
      },
    );
    outgoing.on("error", (error) => handler.onError(error));
    handler.onConnect(() =>
      outgoing.destroy(new Error("Verifier request aborted")),
    );
    outgoing.end();
    return true;
  },
};
function sdk(code) {
  const context = createContext({
    URL,
    atob,
    btoa,
    Headers,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto: globalThis.crypto,
    CryptoKey: globalThis.CryptoKey,
    setTimeout,
    clearTimeout,
    process: { env: {} },
    fetch: (url, init) => globalThis.fetch(url, { ...init, dispatcher }),
  });
  runInContext(code, context);
  return context.originalOidc;
}
function token(changes = {}, header = {}, key = pair.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://oidc.vercel.com",
    aud: "owned-audience",
    project_id: "owned-project",
    environment: "preview",
    iat: now,
    exp: now + 60,
    ...changes,
  };
  const input = [{ alg: "RS256", kid: "owned-key", ...header }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
async function outcome(code, jwt, parameters = options) {
  try {
    const result = await sdk(code).verifyVercelOidcToken(jwt, parameters);
    return {
      ok: true,
      project: result.payload.project_id,
      algorithm: result.protectedHeader.alg,
    };
  } catch (error) {
    return { ok: false, name: error.name, message: error.message };
  }
}

it("retains original valid JWT signature/JWKS verification over actual owned TLS", async () => {
  const before = requests;
  const jwt = token();
  const actual = await outcome(compiled.candidate, jwt);
  expect(actual).toEqual({
    ok: true,
    project: "owned-project",
    algorithm: "RS256",
  });
  expect(await outcome(compiled.original, jwt)).toEqual(actual);
  expect(requests - before).toBe(2);
});

it.each([
  {
    name: "issuer",
    expected: "TypeError",
    claims: { iss: "https://wrong.example" },
  },
  {
    name: "project",
    expected: "TypeError",
    claims: { project_id: "foreign-project" },
  },
  {
    name: "environment",
    expected: "TypeError",
    claims: { environment: "production" },
  },
  {
    name: "audience",
    expected: "JWTClaimValidationFailed",
    claims: { aud: "foreign-audience" },
  },
  { name: "expiry", expected: "JWTExpired", claims: { exp: 1 } },
  {
    name: "algorithm",
    expected: "JOSEAlgNotAllowed",
    claims: {},
    header: { alg: "PS256" },
  },
  {
    name: "unknown key",
    expected: "JWKSNoMatchingKey",
    claims: {},
    header: { kid: "not-present" },
  },
  {
    name: "signature",
    expected: "JWSSignatureVerificationFailed",
    claims: {},
    key: otherPair.privateKey,
  },
])(
  "retains original rejection for $name",
  async ({ claims, header, key, expected }) => {
    const jwt = token(claims, header, key);
    const original = await outcome(compiled.original, jwt);
    expect(original.ok).toBe(false);
    expect(original.name).toBe(expected);
    expect(await outcome(compiled.candidate, jwt)).toEqual(original);
  },
);

it("does not bypass required deployment claims or wildcard audience policy", async () => {
  const jwt = token();
  for (const parameters of [{}, { projectId: "*", environment: "preview" }]) {
    const original = await outcome(compiled.original, jwt, parameters);
    expect(original.ok).toBe(false);
    expect(await outcome(compiled.candidate, jwt, parameters)).toEqual(
      original,
    );
  }
});
it("preserves both original empty browser token getters", async () => {
  for (const code of Object.values(compiled)) {
    const original = sdk(code);
    expect(await original.getVercelOidcToken()).toBe("");
    expect(original.getVercelOidcTokenSync()).toBe("");
  }
});
it.each([
  "/unrelated/module.js",
  "/node_modules/jose/dist/webapi/index.js",
  "/node_modules/@vercel/oidc/dist/index.js",
  `${inputs.target}?foreign`,
])("preserves default interop for %s", (id) => {
  const option = oidcNamespaceOption(inputs.target);
  expect(option(inputs.target)).toBe("namespace");
  expect(option(id)).toBe(false);
});
it.each([false, true, "auto", "preferred", "namespace", () => false])(
  "rejects pre-existing interop settings instead of silently replacing them",
  (previous) => {
    const plugin = vercelOidcNamespace(root);
    expect(() =>
      plugin.config(
        { build: { commonjsOptions: { requireReturnsDefault: previous } } },
        { isSsrBuild: false },
      ),
    ).toThrow("Review existing");
  },
);
it("does not resolve or change Node/SSR config", () => {
  const plugin = vercelOidcNamespace("/absent/root");
  expect(
    plugin.config({ build: { ssr: true } }, { isSsrBuild: true }),
  ).toBeUndefined();
});
const sourceFiles = {
  oidcPackage: resolve(dirname(inputs.browser), "../package.json"),
  oidcBrowser: inputs.browser,
  verifier: inputs.verifier,
  josePackage: resolve(dirname(inputs.target), "../../package.json"),
  joseBrowser: inputs.target,
  connectPackage: resolve(
    dirname(
      createRequire(resolve(root, "packages/app-core/package.json")).resolve(
        "@vercel/connect",
      ),
    ),
    "../package.json",
  ),
};
it.each(Object.entries(sourceFiles))(
  "rejects drift in original %s bytes",
  (name, file) => {
    const source = readFileSync(file, "utf8");
    expect(checkOidcNamespaceSource(name, source)).toBe(source);
    expect(() => checkOidcNamespaceSource(name, `${source}\n`)).toThrow(
      "pin mismatch",
    );
  },
);
it("rejects an unknown dependency input rather than widening the pin inventory", () => {
  expect(() => checkOidcNamespaceSource("unknown", "unreviewed")).toThrow(
    "Unknown",
  );
});
it("rejects another consumer of the exact JOSE browser namespace", () => {
  const plugin = vercelOidcNamespace(root);
  plugin.config({}, { isSsrBuild: false });
  expect(() =>
    plugin.generateBundle.call({
      getModuleInfo: () => ({
        importers: ["/unreviewed-consumer.js"],
        dynamicImporters: [],
      }),
    }),
  ).toThrow("Unexpected JOSE");
});
