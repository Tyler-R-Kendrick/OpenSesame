import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPairingError } from "../browser-pairing.js";
import {
  JoinError,
  askToJoin,
  claimInvite,
  joinSeams,
  presentInvite,
  verifyAt,
} from "./client.js";

const TOKEN = `osc_dlg_dlgo_${"a".repeat(32)}.${"B".repeat(43)}`;
const ENDPOINT = "https://vault.example.org";
const SESSION = "session:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const original = { ...joinSeams };

function json<Body extends JsonObject>(status: number, body: Body): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OFFER = {
  offer: {
    id: "dlgo_1",
    manifest_digest: "sha256:ab",
    expires_at: null,
    items: [
      {
        id: "i1",
        display_name: "GitHub",
        provider_id: "github",
        actions: [],
        resources: [],
        required: true,
        dependencies: [],
      },
    ],
  },
};

async function code<T>(promise: Promise<T>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof JoinError ? error.code : String(error);
  }
  return "resolved";
}

beforeEach(() => {
  joinSeams.eligible = () => true;
});
afterEach(() => {
  Object.assign(joinSeams, original);
});

describe("presenting an invite", () => {
  it("presents under the ceremony's approved grant, and only the bearer", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>(async () =>
      json(200, OFFER),
    );
    joinSeams.pairedFetch = paired;
    const offer = await presentInvite(ENDPOINT, TOKEN);
    expect(offer.items).toHaveLength(1);
    const [host, path, init] = paired.mock.calls[0] ?? ["", "", undefined];
    expect(host).toBe(ENDPOINT);
    expect(path).toBe("/api/v1/delegations/present");
    expect(JSON.parse(String(init?.body))).toEqual({ claim_token: TOKEN });
  });

  it("spends nothing where the join cannot be finished", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>();
    joinSeams.pairedFetch = paired;
    joinSeams.eligible = () => false;
    expect(await code(presentInvite(ENDPOINT, TOKEN))).toBe("unavailable_here");
    joinSeams.eligible = () => true;
    expect(await code(presentInvite("http://evil.example", TOKEN))).toBe(
      "bad_endpoint",
    );
    expect(await code(presentInvite(ENDPOINT, "not-a-token"))).toBe(
      "bad_invite",
    );
    joinSeams.pairedFetch = async () => {
      throw new BrowserPairingError("pairing_required");
    };
    expect(await code(presentInvite(ENDPOINT, TOKEN))).toBe("approval_expired");
    expect(paired).not.toHaveBeenCalled();
  });

  it("names the offer's fate from the endpoint's answer", async () => {
    for (const [status, expected] of [
      [401, "verify_failed"],
      [404, "invite_unknown"],
      [409, "invite_spent"],
      [410, "invite_expired"],
      [500, "invalid_response"],
    ] as const) {
      joinSeams.pairedFetch = async () => json(status, { error: "x" });
      expect(await code(presentInvite(ENDPOINT, TOKEN))).toBe(expected);
    }
    joinSeams.pairedFetch = async () => json(200, { offer: { items: "all" } });
    expect(await code(presentInvite(ENDPOINT, TOKEN))).toBe("invalid_response");
    joinSeams.pairedFetch = async () => {
      throw new TypeError("network");
    };
    expect(await code(presentInvite(ENDPOINT, TOKEN))).toBe("unreachable");
  });
});

describe("claiming", () => {
  it("never sends a code that cannot be right", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>();
    joinSeams.pairedFetch = paired;
    const outcome = await code(
      claimInvite(ENDPOINT, {
        token: TOKEN,
        code: "ABCD",
        acceptedItemIds: [],
      }),
    );
    expect(outcome).toBe("code_format");
    expect(paired).not.toHaveBeenCalled();
  });

  it("claims at the ceremony's endpoint with the normalized code", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>(async () =>
      json(201, { delegations: [{}, {}] }),
    );
    joinSeams.pairedFetch = paired;
    const minted = await claimInvite(ENDPOINT, {
      token: TOKEN,
      code: "bcdf ghjk",
      acceptedItemIds: ["i1"],
    });
    expect(minted).toBe(2);
    const [host, path, init] = paired.mock.calls[0] ?? ["", "", undefined];
    expect(host).toBe(ENDPOINT);
    expect(path).toBe("/api/v1/delegations/claim");
    expect(JSON.parse(String(init?.body))).toEqual({
      claim_token: TOKEN,
      user_code: "BCDF-GHJK",
      accepted_item_ids: ["i1"],
    });
  });

  it("tells a code miss from a refusal and a lapsed approval", async () => {
    const claim = () =>
      claimInvite(ENDPOINT, {
        token: TOKEN,
        code: "BCDFGHJK",
        acceptedItemIds: [],
      });
    joinSeams.pairedFetch = async () =>
      json(422, { error: "invalid", detail: "user code mismatch" });
    expect(await code(claim())).toBe("code_mismatch");
    joinSeams.pairedFetch = async () =>
      json(422, {
        error: "invalid",
        detail: "required item i1 was not accepted",
      });
    expect(await code(claim())).toBe("claim_refused");
    joinSeams.pairedFetch = async () => {
      throw new BrowserPairingError("pairing_required");
    };
    expect(await code(claim())).toBe("approval_expired");
  });
});

describe("asking into an open session", () => {
  it("asks with a bounded note and reads the answer", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>(async () =>
      json(202, { id: "r1", decision: "pending" }),
    );
    joinSeams.pairedFetch = paired;
    const receipt = await askToJoin(
      ENDPOINT,
      SESSION,
      "  from the design team ",
    );
    expect(receipt.decision).toBe("pending");
    const [, path, init] = paired.mock.calls[0] ?? ["", "", undefined];
    expect(path).toBe(`/api/v1/shared-sessions/${SESSION}/join-requests`);
    expect(JSON.parse(String(init?.body))).toEqual({
      note: "from the design team",
    });
  });

  it("refuses a malformed id or an overlong note before asking", async () => {
    const paired = vi.fn<typeof joinSeams.pairedFetch>();
    joinSeams.pairedFetch = paired;
    expect(await code(askToJoin(ENDPOINT, "../admin", ""))).toBe("no_session");
    expect(await code(askToJoin(ENDPOINT, SESSION, "x".repeat(281)))).toBe(
      "note_too_long",
    );
    expect(paired).not.toHaveBeenCalled();
  });

  it("maps the endpoint's answers", async () => {
    joinSeams.pairedFetch = async () =>
      json(409, { error: "join_request_pending" });
    expect(await code(askToJoin(ENDPOINT, SESSION, ""))).toBe("already_asked");
    joinSeams.pairedFetch = async () =>
      json(400, { error: "already_in_session" });
    expect(await code(askToJoin(ENDPOINT, SESSION, ""))).toBe("already_member");
    joinSeams.pairedFetch = async () => json(404, { error: "not_found" });
    expect(await code(askToJoin(ENDPOINT, SESSION, ""))).toBe("no_session");
  });
});

describe("verifying", () => {
  it("needs a sign-in service and a live approval", async () => {
    joinSeams.identityApi = () => "";
    expect(await code(verifyAt(ENDPOINT, new AbortController().signal))).toBe(
      "verify_needs_identity",
    );
    joinSeams.identityApi = () => "https://id.example.org";
    joinSeams.grant = () => null;
    expect(await code(verifyAt(ENDPOINT, new AbortController().signal))).toBe(
      "approval_expired",
    );
  });

  it("verifies against the ceremony's endpoint, not the app's", async () => {
    joinSeams.identityApi = () => "https://id.example.org";
    joinSeams.grant = () => ({
      clientId: "client-1",
      hostApi: ENDPOINT,
      expiresAt: Date.now() + 60_000,
      capabilities: ["host.sync.read"],
    });
    const paired = vi.fn<typeof joinSeams.pairedFetch>(async () =>
      json(200, {}),
    );
    joinSeams.pairedFetch = paired;
    joinSeams.authorize = vi.fn(async (request, _signal, via) => {
      expect(request).toEqual({
        operation: "browser.authenticate",
        target_id: "client-1",
        transition: null,
      });
      await via?.("/api/v1/host-authorizations", { method: "POST" });
      return null;
    });
    await verifyAt(ENDPOINT, new AbortController().signal);
    expect(paired.mock.calls[0]?.[0]).toBe(ENDPOINT);
  });
});
