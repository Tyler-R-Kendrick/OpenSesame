import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "../identity.js";
import {
  DropError,
  type DropManifest,
  createDropSession,
  dropLink,
  dropSeams,
  dropStateFromClaim,
  guardManifest,
  keptCopyFromPayload,
  openDrop,
  pollDrop,
  sealDrop,
  sweepDrop,
  sweepDrops,
} from "./drop.js";
import { type DropItem, createItem } from "./model.js";

const identityFetch = vi.hoisted(() => vi.fn());
const connectProvisional = vi.hoisted(() => vi.fn());
// Tests run session-less: the guest path. ensureIdentitySession must mint a
// provisional principal for drop creation rather than refusing.
const provisionalSession = vi.hoisted(() => ({
  principalId: "prn_guest",
  accessToken: "pst_guest",
  issuerOrigin: "http://127.0.0.1:8788",
}));

Object.assign(identitySeams, {
  identityFetch,
  identityBase: () => "http://127.0.0.1:8788",
  currentSession: () => null,
  connectProvisional,
});

const originals = { ...dropSeams };

beforeEach(() => {
  identityFetch.mockReset();
  connectProvisional.mockReset();
  connectProvisional.mockResolvedValue(provisionalSession);
  Object.assign(dropSeams, {
    ...originals,
    ceremoniesBase: () => "https://ceremonies.example",
  });
});

afterEach(() => {
  Object.assign(dropSeams, originals);
});

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastFetchBody(): string {
  const call = identityFetch.mock.calls.at(-1);
  if (!call) throw new Error("identityFetch was not called");
  const init: RequestInit = overlapCast(call[1] ?? {});
  return String(init.body ?? "");
}

function textPayload(text = "s3cr3t-api-token") {
  return { kind: "text" as const, name: "Deploy token", text };
}

function filePayload(byteLength: number, contentType = "application/pdf") {
  // Deterministic fill — getRandomValues refuses buffers over 64 KiB.
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) bytes[i] = i % 251;
  return {
    kind: "file" as const,
    name: "w2.pdf",
    contentType,
    bytes,
  };
}

/** Flip the first base64 character deterministically (never a no-op). */
function flipFirst(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

describe("sealDrop / openDrop", () => {
  it("round-trips a text payload", async () => {
    const { manifest, fragmentKey } = await sealDrop(textPayload());
    expect(manifest.kind).toBe("secret-drop");
    expect(manifest.name).toBe("Deploy token");
    expect(manifest.contentType).toBe("text/plain");
    expect(manifest.ciphertext).not.toBe("");
    expect(manifest.nonce).not.toBe("");
    expect(manifest.chunks).toBeUndefined();

    const opened = await openDrop(manifest, fragmentKey);
    expect(opened).toEqual(textPayload());
  });

  it("round-trips a file payload through the chunked layout", async () => {
    const payload = filePayload(100_000);
    const { manifest, fragmentKey } = await sealDrop(payload);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.digest).toBeTruthy();
    expect(manifest.ciphertext).toBe("");

    const opened = await openDrop(manifest, fragmentKey);
    expect(opened.kind).toBe("file");
    if (opened.kind !== "file") return;
    expect(opened.name).toBe(payload.name);
    expect(opened.contentType).toBe(payload.contentType);
    expect(opened.bytes).toEqual(payload.bytes);
  });

  it("refuses a tampered ciphertext, chunk, or digest", async () => {
    const text = await sealDrop(textPayload());
    const flipped = {
      ...text.manifest,
      ciphertext: flipFirst(text.manifest.ciphertext),
    };
    await expect(openDrop(flipped, text.fragmentKey)).rejects.toMatchObject({
      name: "DropError",
      code: "tampered",
    });

    const file = await sealDrop(filePayload(4096));
    const chunk = file.manifest.chunks?.[0];
    if (!chunk) throw new Error("expected a chunk");
    const badChunk = {
      ...file.manifest,
      chunks: [{ ...chunk, ciphertext: flipFirst(chunk.ciphertext) }],
    };
    await expect(openDrop(badChunk, file.fragmentKey)).rejects.toMatchObject({
      code: "tampered",
    });
    const badWholeDigest = {
      ...file.manifest,
      digest: `${file.manifest.digest === "AAAA" ? "BBBB" : "AAAA"}`,
    };
    await expect(
      openDrop(badWholeDigest, file.fragmentKey),
    ).rejects.toMatchObject({ code: "tampered" });
  });

  it("refuses the wrong key and a malformed key", async () => {
    const first = await sealDrop(textPayload());
    const second = await sealDrop(textPayload());
    await expect(
      openDrop(first.manifest, second.fragmentKey),
    ).rejects.toMatchObject({ code: "tampered" });
    await expect(openDrop(first.manifest, "c2hvcnQ")).rejects.toMatchObject({
      code: "invalid_key",
    });
  });

  it("enforces the 1 MiB ciphertext cap with a clear error", async () => {
    await expect(sealDrop(filePayload(1_048_576))).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await expect(
      sealDrop(textPayload("x".repeat(2 * 1_048_576))),
    ).rejects.toMatchObject({
      code: "payload_too_large",
    });
    // Just under the cap (sealing adds the 16-byte GCM tag) still seals.
    const under = await sealDrop(filePayload(1_048_556));
    expect(under.manifest.chunks).toHaveLength(1);
  });

  it("guards malformed manifests before decoding anything", async () => {
    expect(() => guardManifest(null)).toThrowError(DropError);
    expect(() => guardManifest({ kind: "other" })).toThrowError(DropError);
    const { manifest } = await sealDrop(filePayload(128));
    expect(() =>
      guardManifest({ ...manifest, digest: undefined }),
    ).toThrowError(DropError);
    expect(() => guardManifest({ ...manifest, chunks: [] })).toThrowError(
      DropError,
    );
    expect(guardManifest(manifest)).toEqual(manifest);
  });
});

describe("claim transport", () => {
  it("creates a manifest-only resource_bundle claim and maps the session", async () => {
    const { manifest, fragmentKey } = await sealDrop(textPayload());
    identityFetch.mockResolvedValueOnce(
      jsonResponse({
        claimId: "clm_1",
        claimToken: "osc_clm_clm_1.secret",
        userCode: "ABCD-EFGH",
        verificationUri: "http://127.0.0.1:8788/v1/claims/clm_1/verify",
        expiresAt: "2026-08-29T21:00:00.000Z",
        targetManifestDigest: "digest",
        pollIntervalSeconds: 5,
      }),
    );

    const session = await createDropSession(manifest, 600_000);
    expect(session).toEqual({
      claimId: "clm_1",
      bearerToken: "osc_clm_clm_1.secret",
      userCode: "ABCD-EFGH",
      verifyUrl: "https://ceremonies.example/claim",
      expiresAt: "2026-08-29T21:00:00.000Z",
    });

    const [path, init] = identityFetch.mock.calls.at(-1) ?? [];
    expect(path).toBe("/v1/claims");
    const sent = JSON.parse(lastFetchBody());
    expect(sent.type).toBe("resource_bundle");
    expect(sent.targetManifest).toEqual(manifest);
    expect(sent.ttlSeconds).toBe(600);
    expect(String(overlapCast(init).method)).toBe("POST");

    // The fragment key never leaves the browser: not in the manifest…
    expect(JSON.stringify(manifest)).not.toContain(fragmentKey);
    // …and not in the request body the seam sent.
    expect(lastFetchBody()).not.toContain(fragmentKey);
  });

  it("mints an anonymous provisional session for a guest before creating the claim", async () => {
    const { manifest } = await sealDrop(textPayload());
    identityFetch.mockResolvedValueOnce(
      jsonResponse({
        claimId: "clm_1",
        claimToken: "osc_clm_clm_1.secret",
        userCode: "ABCD-EFGH",
        verificationUri: "http://127.0.0.1:8788/v1/claims/clm_1/verify",
        expiresAt: "2026-08-29T21:00:00.000Z",
        targetManifestDigest: "digest",
        pollIntervalSeconds: 5,
      }),
    );

    await createDropSession(manifest, 600_000);
    expect(connectProvisional).toHaveBeenCalledTimes(1);
    const mintOrder = connectProvisional.mock.invocationCallOrder[0] ?? 0;
    const postOrder = identityFetch.mock.invocationCallOrder[0] ?? 0;
    expect(mintOrder).toBeLessThan(postOrder);
  });

  it("maps a failed provisional mint to unreachable without posting", async () => {
    const { manifest } = await sealDrop(textPayload());
    connectProvisional.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createDropSession(manifest, 60_000)).rejects.toMatchObject({
      code: "unreachable",
    });
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("maps creation refusals to DropError", async () => {
    const { manifest } = await sealDrop(textPayload());
    identityFetch.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(createDropSession(manifest, 60_000)).rejects.toMatchObject({
      code: "refused",
    });

    identityFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(createDropSession(manifest, 60_000)).rejects.toMatchObject({
      code: "refused",
    });

    identityFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createDropSession(manifest, 60_000)).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("polls with the claim bearer and maps every lifecycle state", async () => {
    identityFetch.mockResolvedValueOnce(
      jsonResponse({ status: "pending" }, 400),
    );
    await expect(pollDrop("clm_1", "osc_clm_clm_1.secret")).resolves.toBe(
      "pending",
    );
    const [, pollInit] = identityFetch.mock.calls.at(-1) ?? [];
    const pollRequest: RequestInit = overlapCast(pollInit ?? {});
    const headers = new Headers(pollRequest.headers);
    expect(headers.get("x-claim-token")).toBe("osc_clm_clm_1.secret");

    for (const [status, expected] of [
      ["presented", "consumed"],
      ["authenticated", "consumed"],
      ["reviewed", "consumed"],
      ["completed", "consumed"],
      ["expired", "expired"],
      ["denied", "expired"],
      ["revoked", "expired"],
    ] as const) {
      identityFetch.mockResolvedValueOnce(jsonResponse({ status }, 400));
      await expect(pollDrop("clm_1", "token")).resolves.toBe(expected);
    }

    // Fall back to the nested claim projection when `status` is absent.
    identityFetch.mockResolvedValueOnce(
      jsonResponse({ claim: { state: "completed" } }),
    );
    await expect(pollDrop("clm_1", "token")).resolves.toBe("consumed");

    identityFetch.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(pollDrop("clm_1", "token")).rejects.toMatchObject({
      code: "refused",
    });

    identityFetch.mockResolvedValueOnce(jsonResponse({ status: "???" }));
    await expect(pollDrop("clm_1", "token")).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("maps claim states directly", () => {
    expect(dropStateFromClaim("pending")).toBe("pending");
    expect(dropStateFromClaim("completed")).toBe("consumed");
    expect(dropStateFromClaim("expired")).toBe("expired");
    expect(() => dropStateFromClaim("unknown")).toThrowError(DropError);
  });
});

describe("dropLink", () => {
  it("carries bearer and key in the fragment only", () => {
    const link = dropLink(
      "https://ceremonies.example/claim",
      "osc_clm_clm_1.secret",
      "keymaterial-_",
    );
    expect(link).toBe(
      "https://ceremonies.example/claim#token=osc_clm_clm_1.secret&key=keymaterial-_",
    );
    const fragment = new URLSearchParams(link.split("#")[1] ?? "");
    expect(fragment.get("token")).toBe("osc_clm_clm_1.secret");
    expect(fragment.get("key")).toBe("keymaterial-_");
    expect(link.split("#")[0]).not.toContain("keymaterial");
  });
});

describe("kept copies", () => {
  it("converts payloads into their JSON-safe kept form", async () => {
    expect(keptCopyFromPayload(textPayload("keep me"))).toEqual({
      kind: "text",
      text: "keep me",
    });
    const file = filePayload(64);
    const kept = keptCopyFromPayload(file);
    expect(kept.kind).toBe("file");
    if (kept.kind !== "file") return;
    expect(kept.name).toBe(file.name);
    expect(kept.contentType).toBe(file.contentType);
    expect(kept.dataB64.length).toBeGreaterThan(0);
  });
});

describe("disposal", () => {
  function dropRecord(changes: Partial<DropItem> = {}): DropItem {
    return {
      ...createItem("drop", "Deploy token"),
      claimId: "clm_1",
      bearerToken: "osc_clm_clm_1.secret",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...changes,
    };
  }

  it("purges terminal records without polling", async () => {
    const purge = vi.fn();
    await sweepDrop(dropRecord({ state: "consumed" }), purge);
    expect(purge).toHaveBeenCalledOnce();
    expect(identityFetch).not.toHaveBeenCalled();

    purge.mockClear();
    await sweepDrop(
      dropRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      purge,
    );
    expect(purge).toHaveBeenCalledOnce();
  });

  it("purges a pending record whose poll reached a terminal state", async () => {
    identityFetch.mockResolvedValueOnce(
      jsonResponse({ status: "presented" }, 400),
    );
    const purge = vi.fn();
    await sweepDrop(dropRecord(), purge);
    expect(purge).toHaveBeenCalledOnce();
  });

  it("keeps a pending record on a pending poll or a failed one", async () => {
    identityFetch.mockResolvedValueOnce(
      jsonResponse({ status: "pending" }, 400),
    );
    const purge = vi.fn();
    await sweepDrop(dropRecord(), purge);
    expect(purge).not.toHaveBeenCalled();

    identityFetch.mockRejectedValueOnce(new TypeError("offline"));
    await sweepDrop(dropRecord(), purge);
    expect(purge).not.toHaveBeenCalled();
  });

  it("sweeps only live drop records out of a mixed body", async () => {
    identityFetch.mockResolvedValue(jsonResponse({ status: "pending" }, 400));
    const login = createItem("login", "example");
    const pending = dropRecord();
    const consumed = dropRecord({ state: "consumed" });
    const trashed = { ...dropRecord(), deletedAt: new Date().toISOString() };
    const purged: string[] = [];
    await sweepDrops([login, pending, consumed, trashed], async (id) => {
      purged.push(id);
      await Promise.resolve();
    });
    expect(purged).toEqual([consumed.id]);
  });
});

describe("manifest shape", () => {
  it("matches the contract keys for a text drop", async () => {
    const { manifest } = await sealDrop(textPayload());
    const keys = Object.keys(manifest).sort();
    expect(keys).toEqual(
      ["ciphertext", "contentType", "kind", "name", "nonce"].sort(),
    );
    const typed: DropManifest = manifest;
    expect(typed.kind).toBe("secret-drop");
  });
});
