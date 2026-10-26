import { once } from "node:events";
import { createServer } from "node:http";
import { isString } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createOpenSesameProvider } from "./create-provider.js";

const metadataUrl = "https://client.example/sector.json";
const redirect = "https://client.example/callback";

async function registerWithMetadata(response: Response) {
  const nativeFetch = globalThis.fetch;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      if (String(input) === metadataUrl) return response;
      return nativeFetch(input, options);
    });
  const { provider } = createOpenSesameProvider({
    env: { dcrEnabled: true, isProduction: false },
  });
  const token = await new provider.InitialAccessToken({}).save();
  const server = createServer(provider.callback());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || isString(address)) throw new Error("Missing address");
  try {
    const registered = await nativeFetch(
      `http://127.0.0.1:${address.port}/reg`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          redirect_uris: [redirect],
          sector_identifier_uri: metadataUrl,
        }),
      },
    );
    expect(fetch).toHaveBeenCalledWith(metadataUrl, expect.anything());
    return { status: registered.status, body: await registered.json() };
  } finally {
    fetch.mockRestore();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("DCR metadata response limits", () => {
  it("rejects an oversized declared response before consuming its body", async () => {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await registerWithMetadata(
      new Response(stream, { headers: { "content-length": "104857600" } }),
    );
    expect(result.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(reads).toBe(0);
  });

  it("cancels an unbounded chunked response once the byte limit is crossed", async () => {
    let bytes = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bytes += 4096;
          controller.enqueue(new Uint8Array(4096));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await registerWithMetadata(new Response(stream));
    expect(result.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(bytes).toBeLessThanOrEqual(64 * 1024 + 4096);
  });

  it("preserves authorized registration with a valid sector document", async () => {
    const result = await registerWithMetadata(Response.json([redirect]));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ sector_identifier_uri: metadataUrl });
  });
});
