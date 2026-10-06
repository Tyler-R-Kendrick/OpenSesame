import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { z } from "zod";

// Resolve through each installed consumer so the check exercises its actual override.
const redteamRequire = createRequire(
  new URL("../../tests/redteam/package.json", import.meta.url),
);
const promptRequire = createRequire(redteamRequire.resolve("promptfoo"));
const proxyRequire = createRequire(promptRequire.resolve("proxy-agent"));
const pacRequire = createRequire(proxyRequire.resolve("pac-proxy-agent"));
const uriRequire = createRequire(pacRequire.resolve("get-uri"));

test("proxy FTP consumer preserves Unix listing metadata and client construction", () => {
  const ftp = uriRequire("basic-ftp");
  const records = ftp.parseList(
    "-rw-r--r-- 1 owner group 12 Jan 02 2026 fixture name.txt\r\n",
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "fixture name.txt");
  assert.equal(records[0].size, 12);
  const client = new ftp.Client();
  client.close();
  assert.equal(client.closed, true);
});

test("promptfoo's Git consumer rejects unsafe configuration before executing git", async () => {
  const { simpleGit } = promptRequire("simple-git");
  await assert.rejects(
    simpleGit().raw(["-c", "include.path=fixture", "status"]),
    /unsafe|not permitted|not allowed|not supported/i,
  );
  await assert.rejects(
    simpleGit().raw(["-c", "trailer.fixture.command=fixture", "status"]),
    /unsafe|not permitted|not allowed|not supported/i,
  );
});

test("promptfoo's modern YAML consumer preserves typed JSON-compatible configuration", () => {
  const yaml = promptRequire("js-yaml");
  assert.deepEqual(
    yaml.load("enabled: true\nproviders: [fixture]\nretries: 0\n"),
    {
      enabled: true,
      providers: ["fixture"],
      retries: 0,
    },
  );
});

test("unused vulnerable optional consumers are unavailable", () => {
  assert.throws(() => promptRequire.resolve("jks-js"), /Cannot find module/);
  const rootRequire = createRequire(
    new URL("../../package.json", import.meta.url),
  );
  const wxtRequire = createRequire(rootRequire.resolve("wxt"));
  assert.throws(() => wxtRequire.resolve("web-ext"), /Cannot find module/);
  assert.throws(() => wxtRequire.resolve("web-ext-run"), /Cannot find module/);
});

test("promptfoo performs ordinary HTTP and refuses omitted JKS before transport", async () => {
  vi.stubEnv("PROMPTFOO_DISABLE_TELEMETRY", "1");
  vi.stubEnv("PROMPTFOO_CACHE_ENABLED", "false");
  let requests = 0;
  let connections = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ output: "fixture" }));
  });
  server.on("connection", () => {
    connections += 1;
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    const { loadApiProvider } = await import(
      new URL("./index.js", pathToFileURL(redteamRequire.resolve("promptfoo")))
        .href
    );
    const endpoint = `http://127.0.0.1:${address.port}`;
    const provider = await loadApiProvider(endpoint, {
      options: { config: { method: "GET", responseParser: "json.output" } },
    });
    const result = await provider.callApi("fixture", { vars: {} });
    assert.equal(result.output, "fixture");
    assert.equal(requests, 1);
    assert.equal(connections, 1);

    const jksProvider = await loadApiProvider(
      `https://127.0.0.1:${address.port}`,
      {
        options: {
          config: {
            method: "GET",
            signatureAuth: {
              type: "jks",
              keystoreContent: "AA==",
              keystorePassword: "fixture",
            },
          },
        },
      },
    );
    await assert.rejects(
      jksProvider.callApi("fixture", { vars: {} }),
      /JKS certificate support requires the "jks-js" package/,
    );
    assert.equal(requests, 1);
    assert.equal(connections, 1);
  } finally {
    vi.unstubAllEnvs();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});
