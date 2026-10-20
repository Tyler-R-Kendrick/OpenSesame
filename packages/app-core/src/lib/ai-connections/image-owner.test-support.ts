import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { decodeAiImage } from "./image-output.js";
import { OwnedAiImage } from "./owned-image.js";
import { saveAiConnection } from "./runtime.js";
import {
  SCRIBE_TOKEN,
  ownedSpeechAudio,
  speechTlsFixture,
} from "./speech-tls.test-support.js";
import { RASTER_FIXTURES } from "./stability-tls.test-support.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";

/** Uses the actual sealed saved-key flow, not a fabricated image-owner callback. */
export async function imageOwnerFixture() {
  const vault = await runtimeFixture();
  const http = await speechTlsFixture();
  const route = new AbortController();
  let valid = true;
  let captures = 0;
  const port = {
    ...http.port,
    signal: route.signal,
    assertCurrent() {
      if (!valid) throw new Error("Original route withdrawn");
      http.port.assertCurrent();
    },
  };
  const unbind = bindAiConnectionTransport({
    ...port,
    capture() {
      captures++;
      return port;
    },
  });
  const draft: AiConnectionDraft = {
    providerId: "elevenlabs",
    name: "Saved image owner fixture",
    family: "elevenlabs_scribe",
    baseUrl: http.baseUrl,
    model: "scribe_v2",
    authentication: "api-key",
    apiKey: SCRIBE_TOKEN,
    tokenParameter: "max_tokens",
  };
  let closed = false;
  try {
    const saved = await saveAiConnection(draft, undefined, undefined, {
      audio: ownedSpeechAudio(),
    });
    const caller = new AbortController();
    const prepared = await OwnedAiImage.prepare(saved.connectionId, {
      signal: caller.signal,
      assertCurrent() {},
    });
    const image = decodeAiImage(RASTER_FIXTURES.png, "image/png", "");
    const token = vaultStore
      .getSnapshot()
      .items.find((item) => item.kind === "credential");
    if (!token || token.kind !== "credential" || token.method.type !== "token")
      throw new Error("Saved token missing");
    return {
      prepared,
      image,
      token,
      caller,
      saved,
      http,
      captures: () => captures,
      withdrawFeature() {
        unbind();
      },
      withdrawRoute() {
        valid = false;
      },
      abortRoute() {
        route.abort();
      },
      async close() {
        if (closed) return;
        closed = true;
        prepared.owner.release();
        unbind();
        await http.close();
        await vault.close();
      },
    };
  } catch (error) {
    unbind();
    await http.close();
    await vault.close();
    throw error;
  }
}
