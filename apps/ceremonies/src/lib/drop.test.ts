import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropAcceptanceError,
  dropSeams,
  guardDropManifest,
  openDrop,
  presentDrop,
  readDropFragment,
} from "./drop.js";

const fetchFn = vi.hoisted(() => vi.fn());

beforeEach(() => {
  fetchFn.mockReset();
  Object.assign(dropSeams, { fetchFn });
});

afterEach(() => {
  Object.assign(dropSeams, { fetchFn });
});

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function b64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Test-side seal, mirroring the sharer's text layout in apps/pages. */
async function sealText(text: string, name = "Deploy token") {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return {
    manifest: {
      kind: "secret-drop",
      name,
      contentType: "text/plain",
      ciphertext: b64(ct),
      nonce: b64(iv),
    },
    fragmentKey: b64url(raw),
  };
}

describe("readDropFragment", () => {
  it("reads token and key together, and only together", () => {
    expect(readDropFragment("#token=osc_clm_a.b&key=k1_-")).toEqual({
      token: "osc_clm_a.b",
      key: "k1_-",
    });
    expect(readDropFragment("#token=osc_clm_a.b")).toBeNull();
    expect(readDropFragment("#key=k1_-")).toBeNull();
    expect(readDropFragment("")).toBeNull();
  });
});

describe("openDrop", () => {
  it("round-trips a sealed text drop", async () => {
    const { manifest, fragmentKey } = await sealText("s3cr3t");
    await expect(openDrop(manifest, fragmentKey)).resolves.toEqual({
      kind: "text",
      name: "Deploy token",
      text: "s3cr3t",
    });
  });

  it("refuses tampered ciphertext and foreign manifests", async () => {
    const { manifest, fragmentKey } = await sealText("s3cr3t");
    const flipped = {
      ...manifest,
      // A *different* first character, not a literal "A": the ciphertext is
      // random, so one run in 64 already begins with "A" and the tamper was a
      // no-op — `openDrop` then rightly succeeded and this assertion failed.
      // The rest of the time it asserted nothing about tampering at all.
      ciphertext: `${manifest.ciphertext.startsWith("A") ? "B" : "A"}${manifest.ciphertext.slice(1)}`,
    };
    await expect(openDrop(flipped, fragmentKey)).rejects.toMatchObject({
      code: "tampered",
    });
    expect(() => guardDropManifest({ kind: "other" })).toThrowError(
      DropAcceptanceError,
    );
    expect(guardDropManifest(manifest)).toMatchObject({ name: "Deploy token" });
  });
});

describe("presentDrop", () => {
  it("posts token and user code, and returns the manifest", async () => {
    const { manifest } = await sealText("s3cr3t");
    fetchFn.mockResolvedValueOnce(
      jsonResponse({
        id: "clm_1",
        state: "presented",
        targetManifest: manifest,
      }),
    );
    await expect(presentDrop("osc_clm_a.b", "ABCD-EFGH")).resolves.toEqual(
      manifest,
    );
    const [url, init] = fetchFn.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain("/v1/claims/present");
    const sent = JSON.parse(String(overlapCast(init).body ?? ""));
    expect(sent).toEqual({ token: "osc_clm_a.b", userCode: "ABCD-EFGH" });
  });

  it("maps every refusal onto a recipient-readable error", async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_user_code" }, 401),
    );
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "invalid_code",
    });

    fetchFn.mockResolvedValueOnce(
      jsonResponse({ error: "too_many_attempts" }, 429),
    );
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "invalid_code",
    });

    fetchFn.mockResolvedValueOnce(jsonResponse({ error: "EXPIRED" }, 410));
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "expired",
    });

    fetchFn.mockResolvedValueOnce(
      jsonResponse({ error: "INVALID_TRANSITION" }, 422),
    );
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "already_opened",
      message: "This drop was already opened.",
    });

    fetchFn.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "invalid",
    });

    fetchFn.mockRejectedValueOnce(new TypeError("offline"));
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "unreachable",
    });

    fetchFn.mockResolvedValueOnce(jsonResponse({ id: "clm_1" }));
    await expect(presentDrop("t", "c")).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
