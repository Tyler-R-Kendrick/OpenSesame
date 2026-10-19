import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { openBrowserNodeState } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";

export const primaryKey = "primary-owned/read-only~credential";
export type PrimaryContract = {
  id: string;
  name: string;
  origin: string;
  authorization?: string;
  headers?: Record<string, string>;
  parameters: Record<string, string>;
  verifyPath: string;
  readPath: string;
  verifyReply: BoundaryValue;
  reply: BoundaryValue;
  action: string;
  operation: string;
  resultLabel: string;
};
export const primaryContracts: PrimaryContract[] = [
  {
    id: "bamboohr",
    name: "BambooHR",
    origin: "https://contractcompany.bamboohr.com",
    authorization: `Basic ${btoa(`${primaryKey}:x`)}`,
    parameters: { company_domain: "contractcompany" },
    verifyPath: "/api/v1/meta/fields",
    readPath: "/api/v1/meta/fields",
    verifyReply: [{ id: "4340.4", name: "Office", type: "text" }],
    reply: [
      { id: "4340.4", name: "Office", type: "text", alias: "private-alias" },
    ],
    action: "List field definitions",
    operation: "provider.fields.read",
    resultLabel: "Showing 1 of 1 returned field definitions",
  },
  {
    id: "beehiiv",
    name: "Beehiiv",
    origin: "https://api.beehiiv.com",
    authorization: `Bearer ${primaryKey}`,
    parameters: {},
    verifyPath: "/v2/publications",
    readPath: "/v2/publications?limit=20&page=1",
    verifyReply: {
      data: [{ id: "pub_owned", name: "Journal" }],
      limit: 10,
      page: 1,
    },
    reply: {
      data: [
        { id: "pub_owned", name: "Journal", organization_name: "private-org" },
      ],
      limit: 20,
      page: 1,
    },
    action: "List publications",
    operation: "provider.publications.read",
    resultLabel: "Showing 1 publications from first page",
  },
  {
    id: "clickup",
    name: "ClickUp",
    origin: "https://api.clickup.com",
    authorization: primaryKey,
    parameters: {},
    verifyPath: "/api/v2/user",
    readPath: "/api/v2/team",
    verifyReply: { user: { id: 1, username: "Owned" } },
    reply: {
      teams: [
        {
          id: "7",
          name: "Engineering",
          members: [{ user: { email: "private@example.test" } }],
        },
      ],
    },
    action: "List workspaces",
    operation: "provider.workspaces.read",
    resultLabel: "Showing 1 of 1 returned workspaces",
  },
];

function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "primary-native-resource-"));
  execFileSync(
    "openssl",
    [
      ..."req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost".split(
        " ",
      ),
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

function routeOracle(
  tls: ReturnType<typeof certificate>,
  contract: PrimaryContract,
) {
  const requests: { authorized: boolean; path: string; emptyBody: boolean }[] =
    [];
  let respond = (response: ServerResponse) =>
    response.end(JSON.stringify(contract.reply));
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const authorized =
      request.method === "GET" &&
      [contract.verifyPath, contract.readPath].includes(request.url ?? "") &&
      request.headers.authorization === contract.authorization &&
      Object.entries(contract.headers ?? {}).every(
        ([name, value]) => request.headers[name] === value,
      ) &&
      (contract.id !== "bamboohr" ||
        request.headers.accept === "application/json") &&
      request.headers.cookie === undefined;
    const emptyBody = Buffer.concat(chunks).length === 0;
    requests.push({ authorized, path: request.url ?? "", emptyBody });
    response.setHeader("content-type", "application/json");
    if (!authorized || !emptyBody) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: primaryKey } }));
      return;
    }
    if (
      request.url === contract.verifyPath &&
      contract.verifyPath !== contract.readPath
    )
      response.end(JSON.stringify(contract.verifyReply));
    else respond(response);
  });
  return {
    server,
    requests,
    reply(body: BoundaryValue, status = 200) {
      respond = (response) => {
        response.writeHead(status);
        return response.end(JSON.stringify(body));
      };
    },
    hold() {
      const arrived = deferred<void>();
      const closed = deferred<void>();
      respond = (response) => {
        response.once("close", () => closed.resolve());
        response.write('{"object":"balance","available":[');
        arrived.resolve();
        return response;
      };
      return { arrived: arrived.promise, closed: closed.promise };
    },
  };
}

/** Match the production controller's captured vault-owner transport lifetime. */
function bindOracleOwner(lifetime: AbortController) {
  const owner = localVaultSessionGuard(vaultStore);
  // The real browser-node controller terminates its transport on owner withdrawal.
  const releaseOwner = vaultStore.subscribe(() => {
    try {
      owner.current();
    } catch {
      lifetime.abort();
    }
  });
  return () => {
    releaseOwner();
    owner.close();
  };
}

function oracleFetch(
  ca: Uint8Array,
  port: number,
  contract: PrimaryContract,
  signal: AbortSignal,
) {
  const fetcher = tlsFetch(ca);
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const source = new Request(input, init);
    const request = new Request(source, {
      signal: AbortSignal.any([source.signal, signal]),
    });
    signal.throwIfAborted();
    if (new URL(request.url).origin !== contract.origin)
      throw new Error("Unexpected provider origin");
    const response = await fetcher(
      new URL(
        new URL(request.url).pathname + new URL(request.url).search,
        `https://127.0.0.1:${port}`,
      ),
      request,
    );
    signal.throwIfAborted();
    return response;
  });
}

/** Independent HTTPS route/auth oracle behind the real captured native transport boundary. */
export async function primaryOracle(contract: PrimaryContract) {
  const storage = await runtimeFixture();
  const tls = certificate();
  const oracle = routeOracle(tls, contract);
  const { server } = oracle;
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || !(address instanceof Object))
    throw new Error("TLS oracle address missing");
  const lifetime = new AbortController();
  const releaseOwner = bindOracleOwner(lifetime);
  const fetch = oracleFetch(tls.cert, address.port, contract, lifetime.signal);
  const snapshot: ReturnType<TailscaleBrowserNode["snapshot"]> = {
    status: "connected",
    hostname: "primary-browser",
    controlURL: "https://controlplane.tailscale.com",
    authURL: "",
    addresses: ["100.64.0.3"],
    peerCount: 1,
    failure: "",
  };
  const node: TailscaleBrowserNode = {
    captureNativeHTTP: () => ({
      fetch,
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
    }),
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer probe in this test");
    },
  };
  await openBrowserNodeState(
    {
      hostname: "primary-browser",
      controlURL: "https://controlplane.tailscale.com",
      nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
        version: 1,
        exitNodeID: "approved-exit",
        trustMode: "public",
        targets: [{ origin: contract.origin, prefixes: ["203.0.113.0/24"] }],
      }),
    },
    vaultStore.getSnapshot().tomb,
    () => {
      if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
    },
  );
  const release = bindTailscaleBrowserNode(node);
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeApiRuntime(activation);
  const browser = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Browser fallback forbidden"));
  return {
    storage,
    ...oracle,
    fetch,
    browser,
    context,
    activation,
    lifetime,
    async close() {
      releaseOwner();
      activation.dispose();
      lifetime.abort();
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tls.directory, { recursive: true, force: true });
      await storage.close();
    },
  };
}
