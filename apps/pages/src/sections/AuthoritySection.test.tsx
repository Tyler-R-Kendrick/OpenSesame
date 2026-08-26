import type { JsonObject } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session: {
  current: {
    principalId: string;
    accessToken: string;
    expiresAt?: string;
    adopted?: boolean;
  } | null;
} = vi.hoisted(() => ({ current: null }));
const orphan = vi.hoisted(() => ({ value: false }));

const currentSession = vi.hoisted(() => vi.fn());
const connectProvisional = vi.hoisted(() => vi.fn());
const adoptToken = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());
const identityFetch = vi.hoisted(() => vi.fn());
const identityJson = vi.hoisted(() => vi.fn());
const noteUnauthorized = vi.hoisted(() => vi.fn());
const probeHost = vi.hoisted(() => vi.fn());
const probeIdentity = vi.hoisted(() => vi.fn());
const probeOrphanSession = vi.hoisted(() => vi.fn());

import { IdentityError, identitySeams } from "../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  adoptToken,
  connectProvisional,
  currentSession,
  endSession,
  hostBase: () => "http://127.0.0.1:8787",
  identityBase: () => "http://127.0.0.1:8788",
  identityFetch,
  identityJson,
  noteUnauthorized,
  probeHost,
  probeIdentity,
  probeOrphanSession,
  useIdentitySession: () => session.current,
  useOrphanSession: () => orphan.value,
});

import { useOnlineSeams } from "../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, { useOnline: () => online.value });

type QueueItemsState = { current: Array<JsonObject> };

const queueItems = vi.hoisted(
  (): QueueItemsState => ({
    current: [],
  }),
);
const enqueue = vi.hoisted(() =>
  vi.fn((item: JsonObject) => {
    queueItems.current.push({
      id: `q_${queueItems.current.length}`,
      createdAt: "2026-08-19T00:00:00Z",
      ...item,
    });
  }),
);
const dequeue = vi.hoisted(() =>
  vi.fn((id: string) => {
    queueItems.current = queueItems.current.filter((item) => item.id !== id);
  }),
);
const loadQueue = vi.hoisted(() => vi.fn(() => queueItems.current));

import { queueSeams } from "../lib/queue.js";
const originalQueueSeams = { ...queueSeams };
Object.assign(queueSeams, { enqueue, dequeue, loadQueue });

const fetchMock = vi.hoisted(() => vi.fn());

import { pagesCannotHostNoteSeams } from "../components/PagesCannotHostNote.js";
const originalPlaneNoteSeams = { ...pagesCannotHostNoteSeams };
Object.assign(pagesCannotHostNoteSeams, { PagesCannotHostNote: () => null });
import { passkeyCeremonyNoteSeams } from "../components/PasskeyCeremonyNote.js";
const originalPasskeyCeremonyNoteSeams = { ...passkeyCeremonyNoteSeams };
Object.assign(passkeyCeremonyNoteSeams, { PasskeyCeremonyNote: () => null });

import { AuthoritySection } from "./AuthoritySection.js";

const activeSession = {
  principalId: "prn_op",
  accessToken: "tok_1",
  expiresAt: "2026-08-20T00:00:00Z",
  adopted: false,
};

const principalBody = {
  id: "prn_op",
  state: "active",
  assurance: "verified",
  createdAt: "2026-08-01T00:00:00Z",
  version: 3,
  verifiedAt: "2026-08-02T00:00:00Z",
  identities: [
    {
      id: "idn_1",
      kind: "oidc",
      issuer: "https://id.example.com",
      assurance: "verified",
      displayHint: "octocat",
    },
  ],
};

function jsonResponse(body: JsonObject | undefined, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    clone() {
      return jsonResponse(body, ok, status);
    },
  };
}

function renderAuthority() {
  return render(
    <MemoryRouter>
      <AuthoritySection />
    </MemoryRouter>,
  );
}

async function openTab(name: RegExp) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

describe("AuthoritySection", () => {
  beforeEach(() => {
    online.value = true;
    session.current = activeSession;
    orphan.value = false;
    queueItems.current = [];
    currentSession.mockReturnValue({ accessToken: "tok_1" });
    probeIdentity.mockResolvedValue("reachable");
    probeHost.mockResolvedValue("unreachable");
    identityJson.mockImplementation((path: string) => {
      if (path === "/v1/principals/me") return Promise.resolve(principalBody);
      if (path === "/v1/principals/identities") {
        return Promise.resolve({
          identities: [
            {
              id: "idn_1",
              kind: "oidc",
              issuer: "https://id.example.com",
              subject: "sub_123",
              assurance: "verified",
              linkedAt: "2026-08-02T00:00:00Z",
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    fetchMock.mockRejectedValue(new TypeError("no network in tests"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  /** Route claim ceremony calls by URL suffix. */
  type ClaimTransportHandlers = {
    present?: JsonObject;
    presentStatus?: number;
    complete?: JsonObject;
    completeStatus?: number;
  };

  function mockClaimTransport(handlers: ClaimTransportHandlers) {
    fetchMock.mockImplementation((input: string) => {
      const url = String(input);
      if (url.endsWith("/v1/claims/present")) {
        if (handlers.presentStatus) {
          return Promise.resolve(
            jsonResponse(
              { error: "claim_refused" },
              false,
              handlers.presentStatus,
            ),
          );
        }
        return Promise.resolve(jsonResponse(handlers.present));
      }
      if (url.includes("/complete")) {
        if (handlers.completeStatus) {
          return Promise.resolve(
            jsonResponse(
              { error: "claim_refused" },
              false,
              handlers.completeStatus,
            ),
          );
        }
        return Promise.resolve(jsonResponse(handlers.complete));
      }
      return Promise.reject(new TypeError(`unexpected fetch ${url}`));
    });
  }

  const presentedClaim = {
    id: "clm_1",
    type: "agent",
    state: "presented",
    expiresAt: "2026-08-20T00:00:00Z",
    version: 2,
    targetManifestDigest: "sha256:abc",
    items: [
      {
        id: "item_1",
        requestedAction: "own",
        targetType: "agent",
        targetId: "agt_1",
        required: true,
      },
    ],
  };

  async function presentToken(token = "osc_clm_part.one", code = "WORD-WORD") {
    await openTab(/Claim ownership/i);
    await userEvent.type(screen.getByLabelText(/^Claim token$/i), token);
    // The consent code is asked for before presenting, not after: presenting
    // spends the token, and finding out the code is missing afterwards would
    // spend it for nothing.
    if (code) {
      await userEvent.type(screen.getByLabelText(/Consent code/i), code);
    }
    await userEvent.click(
      screen.getByRole("button", { name: /Present claim/i }),
    );
  }

  it("shows plane reachability and re-checks on demand", async () => {
    renderAuthority();
    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText("Not answering")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Re-check/i }));
    await waitFor(() =>
      expect(probeIdentity.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it("switches tabs by click and keyboard", async () => {
    renderAuthority();
    await openTab(/Claim ownership/i);
    expect(
      screen
        .getByRole("tab", { name: /Claim ownership/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const tablist = screen.getByRole("tablist");
    const deviceTab = screen.getByRole("tab", { name: /Authorize a device/i });
    fireEvent.keyDown(deviceTab, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: /Claim ownership/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Claim ownership/i }), {
      key: "ArrowLeft",
    });
    expect(deviceTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(deviceTab, { key: "Home" });
    expect(
      screen
        .getByRole("tab", { name: /^Session$/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(deviceTab, { key: "End" });
    expect(
      screen
        .getByRole("tab", { name: /Protocol/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(tablist).toBeTruthy();
  });

  it("loads the principal and linked identities", async () => {
    renderAuthority();
    expect(await screen.findByText("prn_op")).toBeTruthy();
    expect(screen.getAllByText("verified").length).toBeGreaterThan(0);
    expect(screen.getByText("https://id.example.com")).toBeTruthy();
    expect(screen.getByText("sub_123")).toBeTruthy();
    // Copyable id goes through the clipboard.
    await userEvent.click(screen.getByRole("button", { name: "Copy prn_op" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("prn_op");
  });

  it("warns about provisional assurance and shows the empty identity state", async () => {
    identityJson.mockImplementation((path: string) => {
      if (path === "/v1/principals/me") {
        return Promise.resolve({
          ...principalBody,
          assurance: "provisional",
          identities: [],
        });
      }
      return Promise.resolve({ identities: [] });
    });
    renderAuthority();
    expect(
      await screen.findByText(/This is a provisional principal/),
    ).toBeTruthy();
    expect(screen.getByText(/No upstream identity linked/)).toBeTruthy();
  });

  it("surfaces principal load failures", async () => {
    identityJson.mockRejectedValue(new IdentityError("expired", 401));
    renderAuthority();
    expect(await screen.findByText(/session is no longer valid/)).toBeTruthy();
  });

  it("disconnects on demand", async () => {
    renderAuthority();
    await screen.findByText("prn_op");
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    expect(endSession).toHaveBeenCalled();
  });

  it("connects a provisional principal when signed out", async () => {
    session.current = null;
    connectProvisional.mockResolvedValue(undefined);
    renderAuthority();
    expect(await screen.findByText("Not connected")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(connectProvisional).toHaveBeenCalled();
  });

  it("explains connect failures", async () => {
    session.current = null;
    connectProvisional.mockRejectedValue(new IdentityError("slow down", 429));
    renderAuthority();
    await screen.findByText("Not connected");
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(await screen.findByText(/rate-limiting/)).toBeTruthy();
  });

  /** The adopt path is an alternative row now — expand it first. */
  async function openAdopt() {
    await userEvent.click(
      screen.getByRole("button", { name: /Adopt a token you already have/ }),
    );
  }

  it("adopts a pasted token and rejects an empty one", async () => {
    session.current = null;
    adoptToken.mockResolvedValue(undefined);
    renderAuthority();
    await screen.findByText("Not connected");
    await openAdopt();
    // Empty paste is refused before the API is touched.
    const form = screen.getByLabelText(/Access token/i).closest("form");
    if (!form) throw new Error("Access token input must belong to its form");
    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Paste the access token/,
    );
    await userEvent.type(screen.getByLabelText(/Access token/i), "tok_cli");
    await userEvent.click(
      screen.getByRole("button", { name: /Use this token/i }),
    );
    await waitFor(() => expect(adoptToken).toHaveBeenCalledWith("tok_cli"));
  });

  it("explains adopt failures", async () => {
    session.current = null;
    adoptToken.mockRejectedValue(new IdentityError("bad token", 401));
    renderAuthority();
    await screen.findByText("Not connected");
    await openAdopt();
    await userEvent.type(screen.getByLabelText(/Access token/i), "tok_bad");
    await userEvent.click(
      screen.getByRole("button", { name: /Use this token/i }),
    );
    expect(await screen.findByText(/rejected that token/)).toBeTruthy();
  });

  it("offers to end an orphaned server-side session", async () => {
    session.current = null;
    orphan.value = true;
    renderAuthority();
    expect(
      await screen.findByText(/still live on the Identity API/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /End it now/i }));
    expect(endSession).toHaveBeenCalled();
  });

  it("folds ambiguous glyphs in the device user code", async () => {
    renderAuthority();
    await openTab(/Authorize a device/i);
    const input = screen.getByLabelText<HTMLInputElement>(/User code/i);
    await userEvent.type(input, "oil0-wjzx");
    expect(input.value).toBe("0110-WJZX");
  });

  it("approves a device code", async () => {
    identityFetch.mockResolvedValue(jsonResponse({ approved: true }));
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize device/i }),
    );
    expect(await screen.findByText(/Device authorized/)).toBeTruthy();
    expect(identityFetch).toHaveBeenCalledWith(
      "/v1/device/approve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps device approval failures", async () => {
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "expired" }, false, 404),
    );
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize device/i }),
    );
    expect(await screen.findByText(/That code is not recognised/)).toBeTruthy();
  });

  it("stages the device code in the outbox while offline", async () => {
    online.value = false;
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Stage for later/i }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      kind: "device_approve",
      userCode: "WDJD-MKSK",
    });
    expect(await screen.findByText(/staged in the outbox above/)).toBeTruthy();
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("flushes a staged device approval from the outbox", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "device_approve",
        userCode: "WDJD-MKSK",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    identityFetch.mockResolvedValue(jsonResponse({ approved: true }));
    renderAuthority();
    expect(await screen.findByText(/Authorize device WDJD-MKSK/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Flush$/i }));
    expect(await screen.findByText(/Device authorized\./)).toBeTruthy();
    expect(screen.getByText(/1 of 1 went through cleanly/)).toBeTruthy();
    expect(dequeue).toHaveBeenCalledWith("q_1");
  });

  it("keeps a failed flush staged with the reason", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "device_approve",
        userCode: "WDJD-MKSK",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    identityFetch.mockResolvedValue(
      jsonResponse({ error: "expired" }, false, 404),
    );
    renderAuthority();
    await screen.findByText(/Authorize device WDJD-MKSK/);
    await userEvent.click(screen.getByRole("button", { name: /^Flush$/i }));
    expect(await screen.findByText(/That code is not recognised/)).toBeTruthy();
    expect(dequeue).not.toHaveBeenCalled();
  });

  it("discards a staged item without flushing", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "device_approve",
        userCode: "WDJD-MKSK",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    renderAuthority();
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Discard Authorize device WDJD-MKSK/i,
      }),
    );
    expect(dequeue).toHaveBeenCalledWith("q_1");
  });

  it("rejects malformed claim tokens before presenting", async () => {
    renderAuthority();
    await openTab(/Claim ownership/i);
    await userEvent.type(
      screen.getByLabelText(/^Claim token$/i),
      "not-a-claim-token",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Present claim/i }),
    );
    expect(await screen.findByText(/That is not a claim token/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents a claim and completes it", async () => {
    mockClaimTransport({
      present: presentedClaim,
      complete: {
        ...presentedClaim,
        state: "completed",
        won: true,
        preserved: { principalId: "prn_op", agentId: "agt_1" },
      },
    });
    renderAuthority();
    await presentToken();
    // Step 2 shows the review with the item manifest.
    expect(await screen.findByText("sha256:abc")).toBeTruthy();
    expect(screen.getByText("agt_1")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Accept and take ownership/i }),
    );
    expect(
      await screen.findByText(/Ownership is attached to your principal/),
    ).toBeTruthy();
    const completeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/complete"),
    );
    expect(completeCall).toBeTruthy();
    expect(JSON.parse(String(completeCall?.[1]?.body))).toMatchObject({
      acceptedItemIds: ["item_1"],
      claimToken: "osc_clm_part.one",
    });
  });

  it("reports a claim another principal won", async () => {
    mockClaimTransport({
      present: presentedClaim,
      complete: { ...presentedClaim, state: "completed", won: false },
    });
    renderAuthority();
    await presentToken();
    await screen.findByText("sha256:abc");
    await userEvent.click(
      screen.getByRole("button", { name: /Accept and take ownership/i }),
    );
    expect(
      await screen.findByText(/ownership did not move to you/),
    ).toBeTruthy();
  });

  it("maps present failures by status", async () => {
    mockClaimTransport({ presentStatus: 410 });
    renderAuthority();
    await presentToken();
    expect(await screen.findByText(/That claim has expired/)).toBeTruthy();

    mockClaimTransport({ presentStatus: 401 });
    await presentToken("osc_clm_two.dot");
    expect(
      await screen.findByText(/That claim token is not valid/),
    ).toBeTruthy();

    mockClaimTransport({ presentStatus: 404 });
    await presentToken("osc_clm_three.dot");
    expect(
      await screen.findByText(/No claim exists for that token/),
    ).toBeTruthy();

    mockClaimTransport({ presentStatus: 409 });
    await presentToken("osc_clm_four.dot");
    expect(
      await screen.findByText(/Someone else is completing this claim/),
    ).toBeTruthy();

    mockClaimTransport({ presentStatus: 422 });
    await presentToken("osc_clm_five.dot");
    expect(await screen.findByText(/not in a presentable state/)).toBeTruthy();
  });

  it("reports an unreachable Identity API when presenting", async () => {
    // fetchMock rejects with TypeError by default.
    renderAuthority();
    await presentToken();
    expect(
      await screen.findByText(/Could not reach the Identity API/),
    ).toBeTruthy();
  });

  it("discards the claim when the principal changes mid-present", async () => {
    fetchMock.mockImplementation((input: string) => {
      currentSession.mockReturnValue({ accessToken: "tok_other" });
      return Promise.resolve(jsonResponse(presentedClaim));
    });
    renderAuthority();
    await presentToken();
    expect(
      await screen.findByText(/changed while the claim was being read/),
    ).toBeTruthy();
  });

  it("refuses to complete when the server did not report items", async () => {
    const noItems = {
      ...presentedClaim,
      items: undefined,
      version: undefined,
    };
    mockClaimTransport({ present: noItems });
    renderAuthority();
    await presentToken();
    expect(await screen.findByText(/did not report the claim/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Accept and take ownership/i }),
    );
    expect(
      await screen.findByText(/completing requires naming each item/),
    ).toBeTruthy();
  });

  it("maps complete failures by status", async () => {
    mockClaimTransport({
      present: presentedClaim,
      completeStatus: 409,
    });
    renderAuthority();
    await presentToken();
    await screen.findByText("sha256:abc");
    await userEvent.click(
      screen.getByRole("button", { name: /Accept and take ownership/i }),
    );
    expect(
      await screen.findByText(/Another principal completed this claim first/),
    ).toBeTruthy();
  });

  it("blocks completing when the session is gone", async () => {
    mockClaimTransport({ present: presentedClaim });
    renderAuthority();
    await presentToken();
    await screen.findByText("sha256:abc");
    currentSession.mockReturnValue(null);
    await userEvent.click(
      screen.getByRole("button", { name: /Accept and take ownership/i }),
    );
    expect(
      await screen.findByText(/no longer has one\. Connect on the Session tab/),
    ).toBeTruthy();
  });

  it("discards a presented claim without completing", async () => {
    mockClaimTransport({ present: presentedClaim });
    renderAuthority();
    await presentToken();
    await screen.findByText("sha256:abc");
    await userEvent.click(screen.getByRole("button", { name: /Discard/i }));
    expect(screen.queryByText("sha256:abc")).toBeNull();
  });

  it("stages a claim while offline", async () => {
    online.value = false;
    renderAuthority();
    await openTab(/Claim ownership/i);
    await userEvent.type(
      screen.getByLabelText(/^Claim token$/i),
      "osc_clm_part.one",
    );
    await userEvent.type(screen.getByLabelText(/Consent code/i), "WORD-WORD");
    await userEvent.click(
      screen.getByRole("button", { name: /Stage for later/i }),
    );
    // The code is staged with the token because the flush completes without a
    // chance to ask for it — and it stays in memory alongside the bearer, so
    // neither reaches disk.
    expect(enqueue).toHaveBeenCalledWith({
      kind: "claim_complete",
      claimToken: "osc_clm_part.one",
      userCode: "WORD-WORD",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flushes a staged claim from the outbox", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "claim_complete",
        claimToken: "osc_clm_part.one",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    mockClaimTransport({
      present: presentedClaim,
      complete: { ...presentedClaim, state: "completed", won: true },
    });
    renderAuthority();
    await screen.findByText(/Complete claim …/);
    await userEvent.click(screen.getByRole("button", { name: /^Flush$/i }));
    expect(await screen.findByText(/Claim clm_1 completed/)).toBeTruthy();
    expect(dequeue).toHaveBeenCalledWith("q_1");
  });

  it("keeps a staged claim when its present fails during flush", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "claim_complete",
        claimToken: "osc_clm_part.one",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    mockClaimTransport({ presentStatus: 410 });
    renderAuthority();
    await screen.findByText(/Complete claim …/);
    await userEvent.click(screen.getByRole("button", { name: /^Flush$/i }));
    expect(await screen.findByText(/That claim has expired/)).toBeTruthy();
    expect(dequeue).not.toHaveBeenCalled();
  });

  it("keeps staged items when no principal is connected at flush", async () => {
    queueItems.current = [
      {
        id: "q_1",
        kind: "device_approve",
        userCode: "WDJD-MKSK",
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    currentSession.mockReturnValue(null);
    renderAuthority();
    await screen.findByText(/Authorize device WDJD-MKSK/);
    await userEvent.click(screen.getByRole("button", { name: /^Flush$/i }));
    expect(await screen.findByText(/Needs a principal/)).toBeTruthy();
    expect(dequeue).not.toHaveBeenCalled();
  });

  it("maps device approval server errors", async () => {
    renderAuthority();
    await openTab(/Authorize a device/i);
    const type_and_submit = async (code: string) => {
      const input = screen.getByLabelText(/User code/i);
      await userEvent.clear(input);
      await userEvent.type(input, code);
      await userEvent.click(
        screen.getByRole("button", { name: /Authorize device/i }),
      );
    };

    identityFetch.mockResolvedValue(
      jsonResponse({ error: "operator_token_unconfigured" }, false, 503),
    );
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/no operator token configured/),
    ).toBeTruthy();

    identityFetch.mockResolvedValue(
      jsonResponse({ error: "host_api_unreachable" }, false, 502),
    );
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/could not reach the Host API/),
    ).toBeTruthy();

    identityFetch.mockResolvedValue(
      jsonResponse({ error: "used" }, false, 502),
    );
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/The Host API rejected the approval/),
    ).toBeTruthy();

    identityFetch.mockResolvedValue(
      jsonResponse({ error: "invalid_host_api_url_scheme" }, false, 500),
    );
    await type_and_submit("AAAA-AAAA");
    expect(await screen.findByText(/malformed Host API address/)).toBeTruthy();

    identityFetch.mockResolvedValue(jsonResponse({}, false, 400));
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/rejected the code as malformed/),
    ).toBeTruthy();

    identityFetch.mockResolvedValue(jsonResponse({}, false, 403));
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/session cannot approve devices/),
    ).toBeTruthy();

    identityFetch.mockResolvedValue(
      jsonResponse({ error: "boom" }, false, 500),
    );
    await type_and_submit("AAAA-AAAA");
    expect(
      await screen.findByText(/The Identity API answered 500/),
    ).toBeTruthy();
  });

  it("reports an unreachable Identity API during device approval", async () => {
    identityFetch.mockRejectedValue(new TypeError("down"));
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize device/i }),
    );
    expect(
      await screen.findByText(/Could not reach the Identity API/),
    ).toBeTruthy();
  });

  it("blocks device approval without a live session", async () => {
    currentSession.mockReturnValue(null);
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize device/i }),
    );
    expect(await screen.findByText(/connect a principal first/)).toBeTruthy();
    expect(identityFetch).not.toHaveBeenCalled();
  });

  it("warns when the principal changes mid-approval", async () => {
    identityFetch.mockImplementation(() => {
      currentSession.mockReturnValue({ accessToken: "tok_other" });
      return Promise.resolve(jsonResponse({ approved: true }));
    });
    renderAuthority();
    await openTab(/Authorize a device/i);
    await userEvent.type(screen.getByLabelText(/User code/i), "WDJD-MKSK");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize device/i }),
    );
    expect(await screen.findByText(/session changed since/)).toBeTruthy();
  });

  it("shows checking state before probes resolve", () => {
    probeIdentity.mockReturnValue(new Promise(() => {}));
    probeHost.mockReturnValue(new Promise(() => {}));
    renderAuthority();
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
  });

  it("maps remaining connect and adopt errors", async () => {
    session.current = null;
    renderAuthority();
    await screen.findByText("Not connected");

    connectProvisional.mockRejectedValue(new IdentityError("no anon", 403));
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(
      await screen.findByText(/does not allow anonymous provisional/),
    ).toBeTruthy();

    connectProvisional.mockRejectedValue(
      new IdentityError("invalid session control token", 401),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(await screen.findByText(/Something else is answering/)).toBeTruthy();

    connectProvisional.mockRejectedValue(new IdentityError("oops", 500));
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(await screen.findByText(/answered 500 when creating/)).toBeTruthy();

    connectProvisional.mockRejectedValue(new TypeError("down"));
    await userEvent.click(
      screen.getByRole("button", { name: /Create provisional principal/i }),
    );
    expect(
      await screen.findByText(/Could not reach the Identity API/),
    ).toBeTruthy();

    adoptToken.mockRejectedValue(new IdentityError("already adopted", 409));
    await openAdopt();
    await userEvent.type(screen.getByLabelText(/Access token/i), "tok_x");
    await userEvent.click(
      screen.getByRole("button", { name: /Use this token/i }),
    );
    expect(await screen.findByText("already adopted")).toBeTruthy();

    adoptToken.mockRejectedValue(new IdentityError("weird", 500));
    await userEvent.type(screen.getByLabelText(/Access token/i), "tok_y");
    await userEvent.click(
      screen.getByRole("button", { name: /Use this token/i }),
    );
    expect(
      await screen.findByText(/answered 500 when checking that token/),
    ).toBeTruthy();
  });

  it("maps remaining principal load errors", async () => {
    identityJson.mockRejectedValue(new IdentityError("foreign", 403));
    const { unmount } = renderAuthority();
    expect(
      await screen.findByText(/refused to describe this principal/),
    ).toBeTruthy();
    unmount();

    identityJson.mockRejectedValue(new IdentityError("gone", 404));
    renderAuthority();
    expect(await screen.findByText(/no principal with that id/)).toBeTruthy();
  });

  it("shows the protocol assertions and live discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          issuer: "http://127.0.0.1:8788",
          jwks_uri: "http://127.0.0.1:8788/jwks",
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code"],
        }),
      ),
    );
    renderAuthority();
    await openTab(/Protocol/i);
    // The seven assertions are static.
    expect(
      await screen.findByText(/The ceiling is immutable once a task activates/),
    ).toBeTruthy();
    expect(screen.getByText(/ConnectionRef is not capability/)).toBeTruthy();
    // Discovery renders the endpoints and supported-method chips.
    expect(await screen.findByText("http://127.0.0.1:8788/jwks")).toBeTruthy();
    expect(screen.getAllByText("S256").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Not advertised by this deployment/).length,
    ).toBeGreaterThan(0);
  });

  it("explains when discovery cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    renderAuthority();
    await openTab(/Protocol/i);
    expect(
      await screen.findByText(/Could not reach http:\/\/127.0.0.1:8788/),
    ).toBeTruthy();
  });
});
