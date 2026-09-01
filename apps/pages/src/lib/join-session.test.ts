/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessError } from "./access.js";
import { identitySeams } from "./identity.js";
import {
  askToJoin,
  clearJoinStash,
  joinSessionSeams,
  parseInviteInput,
  presentInvite,
  readJoinFromLocation,
  readJoinStash,
  resumeStashedJoin,
  writeJoinStash,
} from "./join-session.js";

const original = { ...joinSessionSeams };
const originalIdentity = {
  currentSession: identitySeams.currentSession,
  hostBase: identitySeams.hostBase,
  hostFetch: identitySeams.hostFetch,
};

const fetchMock = vi.fn<typeof fetch>();

describe("parseInviteInput", () => {
  it("reads a bare claim token", () => {
    expect(parseInviteInput("osc_clm_id.secret")).toEqual({
      host: null,
      token: "osc_clm_id.secret",
    });
  });

  it("reads a link with a fragment bearer", () => {
    expect(
      parseInviteInput("https://host.example/claim#token=osc_clm_id.secret"),
    ).toEqual({
      host: "https://host.example",
      token: "osc_clm_id.secret",
    });
  });

  it("reads a token in the path of an https origin", () => {
    expect(
      parseInviteInput("https://host.example/c/osc_clm_7Q2K.secret"),
    ).toEqual({
      host: "https://host.example",
      token: "osc_clm_7Q2K.secret",
    });
  });

  it("refuses an empty paste", () => {
    expect(parseInviteInput("  ")).toBeNull();
  });
});

describe("readJoinFromLocation", () => {
  it("is silent when the page is not an invite", () => {
    expect(
      readJoinFromLocation("https://pages.example/OpenSesame/"),
    ).toBeNull();
  });

  it("reads this page when it carries a claim token", () => {
    expect(
      readJoinFromLocation(
        "https://pages.example/OpenSesame/#token=osc_clm_id.secret",
        "https://pages.example",
      ),
    ).toEqual({
      host: null,
      token: "osc_clm_id.secret",
    });
  });

  it("keeps the Host origin when the paste is not this page", () => {
    expect(
      readJoinFromLocation(
        "https://host.example/c/osc_clm_id.secret",
        "https://pages.example",
      ),
    ).toEqual({
      host: "https://host.example",
      token: "osc_clm_id.secret",
    });
  });
});

describe("presentInvite", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(joinSessionSeams, original);
  });

  it("posts only the claim token, with no session", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          offer: {
            id: "off_1",
            state: "presented",
            manifest_digest: "sha256:abc",
            expires_at: "2026-08-31T00:00:00Z",
            items: [
              {
                id: "item_1",
                connection_id: "conn_1",
                display_name: "Grafana admin",
                actions: ["read"],
                resources: ["item:1"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const offer = await presentInvite(
      "https://host.example",
      "osc_clm_id.secret",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://host.example/api/v1/delegations/present");
    expect(init).toMatchObject({ method: "POST" });
    expect(String(init?.body)).toBe(
      JSON.stringify({ claim_token: "osc_clm_id.secret" }),
    );
    expect(offer.id).toBe("off_1");
    expect(offer.items[0]?.displayName).toBe("Grafana admin");
  });

  it("collapses a spent offer to one line", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "offer_expired" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      presentInvite("https://host.example", "osc_clm_id.secret"),
    ).rejects.toMatchObject({
      name: "AccessError",
      status: 410,
      message: expect.stringMatching(/unknown, spent, or expired/),
    });
  });
});

describe("askToJoin", () => {
  beforeEach(() => {
    Object.assign(joinSessionSeams, original);
    identitySeams.currentSession = originalIdentity.currentSession;
    identitySeams.hostBase = originalIdentity.hostBase;
    identitySeams.hostFetch = originalIdentity.hostFetch;
  });
  afterEach(() => {
    Object.assign(joinSessionSeams, original);
    identitySeams.currentSession = originalIdentity.currentSession;
    identitySeams.hostBase = originalIdentity.hostBase;
    identitySeams.hostFetch = originalIdentity.hostFetch;
  });

  it("refuses to ask without a signed-in principal", async () => {
    joinSessionSeams.currentSession = () => null;
    await expect(askToJoin("ses_1")).rejects.toBeInstanceOf(AccessError);
    await expect(askToJoin("ses_1")).rejects.toMatchObject({
      code: "session_required",
    });
  });

  it("posts a join request once a session is live", async () => {
    joinSessionSeams.currentSession = () =>
      ({
        principalId: "prn_1",
        accessToken: "tok",
        issuerOrigin: "http://127.0.0.1:18788",
      }) as ReturnType<typeof original.currentSession>;
    joinSessionSeams.hostBase = () => "https://host.example";
    identitySeams.hostFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "jr_1", decision: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const receipt = await askToJoin("ses_1", "covering tonight");
    expect(identitySeams.hostFetch).toHaveBeenCalledWith(
      "/api/v1/shared-sessions/ses_1/join-requests",
      {
        method: "POST",
        body: JSON.stringify({ note: "covering tonight" }),
      },
    );
    expect(receipt).toEqual({ id: "jr_1", decision: "pending" });
  });
});

describe("join stash", () => {
  beforeEach(() => {
    sessionStorage.clear();
    Object.assign(joinSessionSeams, original);
  });
  afterEach(() => {
    sessionStorage.clear();
    Object.assign(joinSessionSeams, original);
  });

  it("round-trips an invite stash", () => {
    writeJoinStash({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    expect(readJoinStash()).toEqual({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    clearJoinStash();
    expect(readJoinStash()).toBeNull();
  });

  it("does not resume without a session", async () => {
    writeJoinStash({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    joinSessionSeams.currentSession = () => null;
    expect(await resumeStashedJoin()).toBe(false);
    const stash = readJoinStash();
    expect(stash?.kind === "invite" && stash.token).toBe("osc_clm_id.secret");
  });

  it("accepts a stashed invite once a session is live", async () => {
    writeJoinStash({
      kind: "invite",
      host: "https://host.example",
      token: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    joinSessionSeams.currentSession = () =>
      ({
        principalId: "prn_1",
        accessToken: "tok",
        issuerOrigin: "http://127.0.0.1:18788",
      }) as ReturnType<typeof original.currentSession>;
    joinSessionSeams.acceptInvite = vi.fn().mockResolvedValue([]);
    expect(await resumeStashedJoin()).toBe(true);
    expect(joinSessionSeams.acceptInvite).toHaveBeenCalledWith({
      claimToken: "osc_clm_id.secret",
      userCode: "FKM2RD",
      acceptedItemIds: ["item_1"],
    });
    expect(readJoinStash()).toBeNull();
  });
});
