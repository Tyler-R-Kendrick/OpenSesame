/** Tiny actual SDK bundles and independent TLS protocol oracle, not a normal PWA build. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { zodJitless } from "@opensesame/app-core/lib/zod-jitless.js";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  mcpBrowserValidator,
  readMcpBrowserInputs,
  transformMcpBrowserClient,
} from "./mcp-browser-validator.mjs";

const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const input = readMcpBrowserInputs(root);
const directory = mkdtempSync(join(tmpdir(), "mcp-explicit-sdk-"));
const closes = [];
let NativeMcpSession;
let Client;
let included;
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function compile(entry, plugins, name) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    resolve: {
      alias: {
        "@opensesame/os-domain/authority-templates": resolve(
          root,
          "packages/os-domain/src/authority-templates/index.ts",
        ),
        "@opensesame/os-domain/wallet": resolve(
          root,
          "packages/os-domain/src/wallet/index.ts",
        ),
        "@opensesame/os-domain": resolve(
          root,
          "packages/os-domain/src/browser.ts",
        ),
      },
    },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: "strict",
        output: { format: "es", inlineDynamicImports: true },
      },
    },
  });
  const chunks = result.output.filter((output) => output.type === "chunk");
  expect(chunks).toHaveLength(1);
  const path = join(directory, `${name}.mjs`);
  writeFileSync(path, chunks[0].code);
  return {
    module: await import(pathToFileURL(path).href),
    ids: Object.keys(chunks[0].modules),
  };
}
beforeAll(async () => {
  // Pages seeds this before any optional schema module evaluates, not after import.
  zodJitless();
  const app = await compile(
    input.appPath,
    [mcpBrowserValidator(root)],
    "native-mcp",
  );
  NativeMcpSession = app.module.NativeMcpSession;
  included = app.ids;
  const sdk = await compile(
    input.clientPath,
    [
      {
        name: "test-exact-sdk-transform",
        transform(source, id) {
          return id === input.clientPath
            ? transformMcpBrowserClient(source)
            : null;
        },
      },
    ],
    "sdk-default",
  );
  Client = sdk.module.Client;
}, 20000);

function tlsFetch(ca) {
  return async (url, init) => {
    const outgoing = new Request(url, init);
    const body = Buffer.from(await outgoing.arrayBuffer());
    return new Promise((resolveResponse, reject) => {
      const request = httpsRequest(
        outgoing.url,
        {
          ca,
          method: outgoing.method,
          headers: Object.fromEntries(outgoing.headers),
          signal: outgoing.signal,
        },
        (incoming) => {
          resolveResponse(
            new Response(
              incoming.statusCode === 204 ? null : Readable.toWeb(incoming),
              { status: incoming.statusCode, headers: incoming.headers },
            ),
          );
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  };
}
function resultFor(rpc, state) {
  if (rpc.method === "initialize")
    return {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "Owned transformed SDK TLS", version: "1" },
    };
  if (rpc.method === "tools/list") {
    const query = { type: "string" };
    if (state.unsafeSchema) query.pattern = "^(a+)+$";
    return {
      tools: [
        {
          name: "search",
          inputSchema: {
            type: "object",
            properties: { query },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { matches: { type: "integer" } },
            required: ["matches"],
            additionalProperties: false,
          },
        },
      ],
    };
  }
  return {
    content: [{ type: "text", text: "Actual transformed SDK result" }],
    structuredContent: { matches: state.badOutput ? "wrong" : 1 },
  };
}
function certificate() {
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  if (!existsSync(cert))
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
      { stdio: "ignore" },
    );
  return { cert: readFileSync(cert), key: readFileSync(key) };
}
async function fixture() {
  const tls = certificate();
  const state = {
    badOutput: false,
    unsafeSchema: false,
    refuse: false,
    hold: false,
  };
  const calls = [];
  let held = () => {};
  const waiting = new Promise((resolveHeld) => {
    held = resolveHeld;
  });
  const server = createServer(tls, async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const row = {
      method: "",
      authorized:
        request.headers.authorization === "Bearer owned-mcp-fixture-key",
      closed: false,
      ended: false,
    };
    response.on("close", () => {
      row.closed = true;
    });
    response.on("finish", () => {
      row.ended = true;
    });
    calls.push(row);
    if (!row.authorized || state.refuse) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const part of request) body += part;
    const rpc = JSON.parse(body);
    row.method = rpc.method;
    if (rpc.id === undefined) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("mcp-session-id", "owned-browser-sdk-session");
    if (state.hold && rpc.method === "tools/call") {
      response.write('{"jsonrpc":');
      held();
      return;
    }
    const result = resultFor(rpc, state);
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const endpoint = `https://127.0.0.1:${server.address().port}/mcp`;
  const binding = {
    providerId: "notion",
    fingerprint: "owned-current-binding",
    issuer: null,
    endpoint,
    resource: endpoint,
    transport: "streamable-http",
  };
  const authorizationRequired = vi.fn(async () => {});
  const session = new NativeMcpSession(binding, {
    fetch: tlsFetch(tls.cert),
    accessGrant: async () => ({ ...binding, token: "owned-mcp-fixture-key" }),
    assertCurrent: () => {},
    authorizationRequired,
  });
  closes.push(async () => {
    await session.dispose();
    server.closeAllConnections();
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  });
  return { session, calls, state, waiting, authorizationRequired };
}

it("retains the real bounded CfWorker and SDK while the compiled graph contains no AJV default", () => {
  expect(
    included.some((id) => id.endsWith("native-mcp-schema-validator.ts")),
  ).toBe(true);
  expect(
    included.some((id) => id.includes("/node_modules/@cfworker/json-schema/")),
  ).toBe(true);
  expect(
    included.filter((id) =>
      /\/node_modules\/(ajv|ajv-formats|fast-uri)\//.test(id),
    ),
  ).toEqual([]);
});
it("the actual transformed SDK constructor fails closed without an explicitly supplied validator", () => {
  expect(() => new Client({ name: "missing-injection", version: "1" })).toThrow(
    "explicit browser JSON Schema validator",
  );
});
it("executes real TLS discovery/invocation and rejects malformed input/output with dynamic code prohibited", async () => {
  const f = await fixture();
  const probes = [];
  const dynamic = vi
    .spyOn(globalThis, "Function")
    .mockImplementation(function blockedDynamicCode() {
      probes.push(new Error("Dynamic code probe").stack);
      throw new EvalError("Strict CSP");
    });
  await expect(
    f.session.connect().catch((error) => {
      expect(probes).toEqual([]);
      throw error;
    }),
  ).resolves.toMatchObject({
    server: { name: "Owned transformed SDK TLS" },
  });
  await expect(
    f.session.callTool("search", { query: 42 }),
  ).rejects.toMatchObject({ code: "arguments" });
  expect(f.calls.some((row) => row.method === "tools/call")).toBe(false);
  await expect(
    f.session.callTool("search", { query: "real query" }),
  ).resolves.toMatchObject({ structuredContent: { matches: 1 } });
  f.state.badOutput = true;
  await expect(
    f.session.callTool("search", { query: "invalid output" }),
  ).rejects.toMatchObject({ code: "response" });
  expect(dynamic).not.toHaveBeenCalled();
  expect(f.calls.every((row) => row.authorized)).toBe(true);
});
it("refuses dangerous advertised schemas before any tools/call reaches the TLS server", async () => {
  const f = await fixture();
  f.state.unsafeSchema = true;
  await expect(f.session.connect()).rejects.toMatchObject({
    code: "schema-limits",
  });
  expect(f.calls.some((row) => row.method === "tools/call")).toBe(false);
});
it("preserves genuine authentication refusal without a fake connected session", async () => {
  const f = await fixture();
  f.state.refuse = true;
  await expect(f.session.connect()).rejects.toThrow();
  expect(f.authorizationRequired).toHaveBeenCalled();
  await expect(
    f.session.callTool("search", { query: "refused" }),
  ).rejects.toMatchObject({ code: "disposed" });
});
it("physically closes a held real TLS result on original session disposal with no late invocation", async () => {
  const f = await fixture();
  await f.session.connect();
  f.state.hold = true;
  const result = expect(
    f.session.callTool("search", { query: "held" }),
  ).rejects.toThrow();
  await f.waiting;
  const count = f.calls.length;
  await f.session.dispose();
  await result;
  await vi.waitFor(() =>
    expect(f.calls.at(-1)).toMatchObject({ closed: true, ended: false }),
  );
  await expect(
    f.session.callTool("search", { query: "stale" }),
  ).rejects.toMatchObject({ code: "disposed" });
  expect(f.calls).toHaveLength(count);
});
