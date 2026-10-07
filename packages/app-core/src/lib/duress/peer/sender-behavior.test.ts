/** @vitest-environment node */
/** Generated owner crypto and signed protocol fixtures; no receiver/network proof. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requiresFreshOwnerAuthentication } from "../../decoy-session.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../../retired-credentials/unlock.js";
import { PEER_BOUNDS } from "./bounds.js";
import {
  decryptPeerPayload,
  encryptPeerPayload,
  generatePeerKeyPair,
  generatePeerWrapKey,
  signPeerEnvelope,
} from "./envelope.js";
import { signPeerReceipt } from "./receipt.js";
import { sendPeerEnvelope } from "./sender.js";

const RETIRED = "generated peer lifecycle retired credential";
const ORIGINAL = "generated peer encrypted payload";
const ORIGIN = "http://127.0.0.1:8787";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll(RETIRED, "synthetic_decoy");
});
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(drains.splice(0));
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "unlocked",
      guest: false,
      decoy: false,
    });
  } finally {
    try {
      fixture.restore();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  }
});
async function transition(mode: "pending" | "fresh") {
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, RETIRED),
  ).resolves.toBe("retired_credential_session");
  expect(fixture.store.getSnapshot().decoy).toBe(true);
  fixture.store.lock();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  if (mode === "fresh") {
    await fixture.store.unlock(PASSWORD);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "unlocked",
      decoy: false,
      guest: false,
    });
  }
}
async function protocol() {
  const issuer = await generatePeerKeyPair();
  const receiver = await generatePeerKeyPair();
  const wrap = await generatePeerWrapKey();
  const ciphertextB64 = await encryptPeerPayload(
    new TextEncoder().encode(ORIGINAL),
    wrap,
  );
  expect(
    new TextDecoder().decode(await decryptPeerPayload(ciphertextB64, wrap)) ===
      ORIGINAL,
  ).toBe(true);
  const envelope = await signPeerEnvelope(
    {
      issuer: "device-generated",
      audience: "receiver-generated",
      principalRef: "principal-generated",
      vaultRef: "vault-generated",
      deviceBindingRef: "binding-generated",
      operation: "peer_status",
      incidentId: "incident-generated",
      policyRevision: 1,
      keyEpoch: 1,
      nonce: `nonce-${crypto.randomUUID()}`,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ciphertextB64,
    },
    issuer.privateKey,
  );
  const receipt = await signPeerReceipt(
    {
      requestNonce: envelope.nonce,
      recipientDeviceBinding: "receiver-binding-generated",
      status: "accepted",
      at: new Date().toISOString(),
    },
    receiver.privateKey,
  );
  const config = {
    registeredOrigin: ORIGIN,
    audience: envelope.audience,
    recipientPublicKey: receiver.publicKey,
  };
  return { envelope, receipt, config, receiver };
}
function installHttp(response: Response) {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => response,
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function observe<T>(pending: Promise<T>) {
  const result = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({
      ok: false as const,
      blocked: /authenticate again/.test(error.message),
    }),
  );
  drains.push(result);
  return result;
}
function barrier() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { held, release };
}

it("accepts only the real paired-key signed receipt and preserves transport restrictions", async () => {
  const input = await protocol();
  const fetch = installHttp(Response.json(input.receipt));
  const result = await sendPeerEnvelope(input.envelope, input.config);
  expect(result).toEqual({ ok: true, receipt: input.receipt });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    `${ORIGIN}/v1/duress/peer/envelope`,
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      mode: "cors",
    }),
  );
  const init = fetch.mock.calls[0]?.[1];
  expect(JSON.parse(String(init?.body))).toEqual(input.envelope);
});
it("refuses a genuinely signed receipt for a different request nonce", async () => {
  const input = await protocol();
  const wrong = await signPeerReceipt(
    {
      requestNonce: "nonce-other-generated",
      recipientDeviceBinding: "receiver-binding-generated",
      status: "accepted",
      at: new Date().toISOString(),
    },
    input.receiver.privateKey,
  );
  installHttp(Response.json(wrong));
  expect(await sendPeerEnvelope(input.envelope, input.config)).toEqual({
    ok: false,
    code: "ambiguous_trigger",
    httpStatus: 200,
  });
});
it("refuses an altered signed status while nonce and paired key still match", async () => {
  const input = await protocol();
  installHttp(Response.json({ ...input.receipt, status: "rejected" }));
  expect(await sendPeerEnvelope(input.envelope, input.config)).toEqual({
    ok: false,
    code: "unavailable_authority",
    httpStatus: 200,
  });
});
it.each([
  {
    name: "body shape",
    response: () => Response.json([]),
    code: "unsupported_factor",
    httpStatus: 200,
  },
  {
    name: "oversized body",
    response: () => new Response("x".repeat(PEER_BOUNDS.httpBodyMaxBytes + 1)),
    code: "unsupported_factor",
    httpStatus: 200,
  },
  {
    name: "HTTP413",
    response: () => new Response("", { status: 413 }),
    code: "unsupported_factor",
    httpStatus: 413,
  },
  {
    name: "unavailable receiver",
    response: () => new Response("Generated refusal", { status: 503 }),
    code: "unavailable_authority",
    httpStatus: 503,
  },
])(
  "retains the exact refusal for $name",
  async ({ response, code, httpStatus }) => {
    const input = await protocol();
    installHttp(response());
    expect(await sendPeerEnvelope(input.envelope, input.config)).toEqual({
      ok: false,
      code,
      httpStatus,
    });
  },
);
it("does not transmit an envelope addressed to another receiver", async () => {
  const input = await protocol();
  const fetch = installHttp(Response.json(input.receipt));
  expect(
    await sendPeerEnvelope(input.envelope, {
      ...input.config,
      audience: "other-generated",
    }),
  ).toEqual({ ok: false, code: "scope_mismatch" });
  expect(fetch).not.toHaveBeenCalled();
});
it("reports incomplete delivery instead of accepting an unreceived receipt", async () => {
  const input = await protocol();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => {
      throw new Error("Generated network failure");
    }),
  );
  expect(await sendPeerEnvelope(input.envelope, input.config)).toEqual({
    ok: false,
    code: "completion_unknown",
  });
});

it.each(["pending", "fresh"] as const)(
  "rejects a held actual receipt body after the starting owner becomes %s",
  async (mode) => {
    const input = await protocol();
    let read = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let emitted = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(next) {
          controller = next;
        },
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const release = () => {
      if (!controller || emitted) return;
      emitted = true;
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify(input.receipt)),
      );
      controller.close();
    };
    releases.push(release);
    installHttp(new Response(stream));
    const pending = observe(sendPeerEnvelope(input.envelope, input.config));
    try {
      await vi.waitFor(() => expect(read).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      await transition(mode);
    } finally {
      release();
    }
    const result = await pending;
    expect(result.ok ? "accepted" : result.blocked ? "blocked" : "error").toBe(
      "blocked",
    );
  },
);
it("rejects even a real valid verification result held across original-owner replacement", async () => {
  const input = await protocol();
  installHttp(Response.json(input.receipt));
  const held = barrier();
  let reached = false;
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    const valid = await verify(...args);
    if (args[1] === input.receiver.publicKey) {
      expect(valid).toBe(true);
      reached = true;
      await held.held;
    }
    return valid;
  });
  const pending = observe(sendPeerEnvelope(input.envelope, input.config));
  try {
    await vi.waitFor(() => expect(reached).toBe(true), {
      timeout: 1000,
      interval: 10,
    });
    await transition("fresh");
  } finally {
    held.release();
  }
  const result = await pending;
  expect(result.ok ? "accepted" : result.blocked ? "blocked" : "error").toBe(
    "blocked",
  );
});
it("accepts a new genuine signed receipt request after fresh original owner authentication", async () => {
  await transition("fresh");
  const input = await protocol();
  installHttp(Response.json(input.receipt));
  expect(await sendPeerEnvelope(input.envelope, input.config)).toEqual({
    ok: true,
    receipt: input.receipt,
  });
});
