import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import { z } from "zod";
import { listenCanaryReceiver } from "./agent-canary-http.js";
import {
  CanaryPairingSchema,
  createControlledCanaryReceiver,
} from "./agent-canary-receiver.js";
import type { ReceiverState } from "./agent-canary-state.js";
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
it("serves genuine loopback signed management and detection-only MCP; refuses foreign origins", async () => {
  const port = await unusedPort();
  const keys = await generateKeyPair("ES256", { extractable: true });
  const pairing = CanaryPairingSchema.parse({
    v: 1,
    endpoint: `http://127.0.0.1:${port}`,
    serviceId: "a".repeat(64),
    bindPort: port,
    origin: "https://vault.example",
    ownerKeyId: "owner-test",
    ownerPublicJwk: await exportJWK(keys.publicKey),
  });
  let state: ReceiverState = {
    v: 1,
    serviceId: pairing.serviceId,
    records: [],
    events: [],
    sequence: 0,
  };
  const receiver = await createControlledCanaryReceiver(pairing, {
    state,
    save: async (next) => {
      state = structuredClone(next);
    },
  });
  const server = await listenCanaryReceiver(receiver);
  async function post<Body>(
    path: string,
    body: Body,
    origin = pairing.origin,
    bearer?: string,
  ) {
    const headers = new Headers({
      Origin: origin,
      "Content-Type": "application/json",
    });
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    return fetch(pairing.endpoint + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
  try {
    const command = {
      kind: "enroll",
      contextId: "b".repeat(64),
      label: "MCP detector",
      artifactKind: "mcp-config",
      retentionDays: 1,
    };
    const denied = await post(
      "/v1/agent-canaries/challenge",
      command,
      "https://foreign.example",
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const challengeResponse = await post(
      "/v1/agent-canaries/challenge",
      command,
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json();
    const idToken = await new SignJWT({ nonce: challenge.nonce })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(pairing.ownerKeyId)
      .setAudience(challenge.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(challenge.expiresAt / 1000))
      .sign(keys.privateKey);
    const enrolled = await post("/v1/agent-canaries/execute", {
      nonce: challenge.nonce,
      idToken,
    });
    expect(enrolled.status).toBe(200);
    const row = state.records[0];
    const artifact = `/v1/agent-canaries/artifacts/${row.record.id}`;
    const init = await post(
      artifact,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "null",
      row.token,
    );
    expect((await init.json()).result.serverInfo.name).toBe(
      "opensesame-canary",
    );
    const called = await post(
      artifact,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "canary_status", arguments: {} },
      },
      "null",
      row.token,
    );
    expect((await called.json()).result.content[0].text).toContain(
      "No production authority",
    );
    expect(state.events.map((event) => event.event)).toEqual([
      "canary_connected",
      "canary_tool_invoked",
    ]);
    const sdk = new Client({ name: "canary-protocol-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(pairing.endpoint + artifact),
      { requestInit: { headers: { Authorization: `Bearer ${row.token}` } } },
    );
    try {
      await sdk.connect(transport);
      expect((await sdk.listTools()).tools.map((tool) => tool.name)).toEqual([
        "canary_status",
      ]);
      const observed = await sdk.callTool({
        name: "canary_status",
        arguments: {},
      });
      expect(observed.isError).not.toBe(true);
    } finally {
      await sdk.close();
    }
    expect(
      (
        await post(
          artifact,
          { jsonrpc: "2.0", id: 3, method: "tools/call" },
          "null",
          "0".repeat(64),
        )
      ).status,
    ).toBe(403);
  } finally {
    await server.close();
  }
});
