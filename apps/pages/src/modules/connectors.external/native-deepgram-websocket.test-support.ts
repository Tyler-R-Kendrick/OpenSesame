import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAMILY_POLICY,
  approvedPlan,
} from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  configureNativeApiConnector,
  nativeApiCleanup,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { tlsFetch } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeRuntime } from "./native-runtime.js";

export const KEY = "fixture-deepgram-api-key";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const close of disposers.splice(0).reverse()) close();
});

function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-deepgram-wss-"));
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
export function audio() {
  const bytes = new Uint8Array(364);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVEfmt "],
    [36, "data"],
  ] as const)
    bytes.set(new TextEncoder().encode(text), offset);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  return { bytes, blob: new Blob([bytes], { type: "audio/wav" }) };
}

function sendResult(
  peer: WebSocket,
  mode: string,
  media: Buffer[],
  requestId: string,
) {
  if (mode === "malformed") {
    peer.send("not JSON");
    return;
  }
  if (mode === "bare") {
    peer.close(1000);
    return;
  }
  peer.send(
    JSON.stringify({
      type: "Results",
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: mode === "echo" ? KEY : "Exact file transcription.",
          },
        ],
      },
      metadata: { request_id: requestId },
    }),
  );
  if (mode !== "missing-metadata")
    peer.send(
      JSON.stringify({
        type: "Metadata",
        request_id: mode === "foreign-request" ? "other-request" : requestId,
        sha256: createHash("sha256").update(Buffer.concat(media)).digest("hex"),
        duration: 0.01,
        channels: 1,
      }),
    );
  if (mode === "hold-after-metadata") return;
  if (mode === "truncated") peer.terminate();
  else peer.close(1000);
}

export async function providerFixture() {
  const tls = certificate();
  const peers = new Set<WebSocket>();
  const media: Buffer[] = [];
  const controls: string[] = [];
  let mode = "complete";
  let closed = 0;
  let deliveredMetadata = 0;
  const server = createServer(tls, (request, response) => {
    expect(request.url).toBe("/v1/projects");
    expect(request.headers.authorization).toBe(`Token ${KEY}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ projects: [{ project_id: "project", name: "Speech" }] }),
    );
  });
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: () => "token",
  });
  server.on("upgrade", (request, socket, head) => {
    expect(request.url).toBe("/v1/listen?model=nova-3");
    expect(request.headers["sec-websocket-protocol"]).toBe(`token,${KEY}`);
    if (mode === "unauthorized") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (peer) =>
      sockets.emit("connection", peer),
    );
  });
  sockets.on("connection", (peer) => {
    const requestId = randomUUID();
    const requestMedia: Buffer[] = [];
    peers.add(peer);
    peer.once("close", () => {
      peers.delete(peer);
      closed += 1;
    });
    peer.on("message", (data, binary) => {
      if (binary) {
        const bytes = Buffer.from(z.instanceof(Buffer).parse(data));
        media.push(bytes);
        requestMedia.push(bytes);
        return;
      }
      const control: { type: string } = JSON.parse(data.toString());
      controls.push(control.type);
      if (control.type !== "CloseStream" || mode === "held") return;
      sendResult(peer, mode, requestMedia, requestId);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address: AddressInfo = overlapCast(server.address());
  return {
    origin: `https://127.0.0.1:${address.port}`,
    wsOrigin: `wss://127.0.0.1:${address.port}`,
    tls,
    media,
    controls,
    peers,
    setMode: (value: string) => {
      mode = value;
    },
    closed: () => closed,
    deliveredMetadata: () => deliveredMetadata,
    noteClientMetadata() {
      deliveredMetadata += 1;
    },
    finish() {
      for (const peer of peers) peer.close(1000);
    },
    async close() {
      for (const peer of peers) peer.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
      expect(peers.size).toBe(0);
    },
  };
}

function metadataFrame(bytes: string): boolean {
  try {
    return z
      .object({ type: z.literal("Metadata") })
      .safeParse(JSON.parse(bytes)).success;
  } catch {
    return false;
  }
}

export function activate(
  fixture: Awaited<ReturnType<typeof providerFixture>>,
  planRead?: () => EffectivePlan | null,
) {
  const test = createTestContext();
  const capability = describeCapability("connectors.external");
  if (!capability) throw new Error("Compiled connector capability missing");
  const plan = approvedPlan(["connectors.external"], {
    ...FAMILY_POLICY,
    network: {
      externalServices: "allow",
      allowedServiceOrigins: [
        "https://api.deepgram.com",
        "wss://api.deepgram.com",
      ],
    },
  });
  const secureFetch = tlsFetch(fixture.tls.cert);
  const egress = createEgressPort({
    capability,
    plan: planRead ?? (() => plan),
    allowedOrigins: ["https://vault.example.test"],
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.deepgram.com");
      return secureFetch(
        new URL(url.pathname + url.search, fixture.origin),
        init,
      );
    },
  });
  const ctx = { ...test.ctx, egress };
  const activation = createActivation(ctx, "connectors.external");
  class ActualFixtureSocket extends WebSocket {
    constructor(input: string | URL, protocols?: string | string[]) {
      const url = new URL(String(input));
      expect(url.origin).toBe("wss://api.deepgram.com");
      super(new URL(url.pathname + url.search, fixture.wsOrigin), protocols, {
        ca: fixture.tls.cert,
      });
      this.on("message", (bytes) => {
        if (metadataFrame(bytes.toString())) fixture.noteClientMetadata();
      });
    }
  }
  vi.stubGlobal("WebSocket", ActualFixtureSocket);
  bindNativeRuntime(ctx, activation);
  disposers.push(activation.dispose);
  return { test, activation, transport: nativeProviderTransport(), egress };
}

const input = {
  providerId: "deepgram",
  displayName: "Speech",
  parameters: {},
  credentials: { api_key: KEY },
};
export async function start() {
  const vault = await runtimeFixture();
  const fixture = await providerFixture();
  const owner = activate(fixture);
  const saved = await configureNativeApiConnector(input, owner.transport);
  disposers.push(registerNativeProviderCleanup("deepgram", nativeApiCleanup));
  return {
    vault,
    fixture,
    owner,
    saved,
    async close() {
      owner.activation.dispose();
      await fixture.close();
      await vault.close();
    },
  };
}
