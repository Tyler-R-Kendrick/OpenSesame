import { describe, expect, it, vi } from "vitest";
import {
  CeremonyRequestError,
  type StashStorage,
  approveDevice,
  createClaimStash,
  parseUserCode,
  readFragmentToken,
} from "./index.js";

function memoryStorage(): StashStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("deep links", () => {
  it("reads a claim bearer from the fragment only", () => {
    expect(readFragmentToken("#token=osc_clm_abc.def")).toBe("osc_clm_abc.def");
    expect(readFragmentToken("token=osc_clm_abc.def")).toBe("osc_clm_abc.def");
    expect(readFragmentToken("#other=x")).toBeNull();
    expect(readFragmentToken("#token=")).toBeNull();
    expect(readFragmentToken("")).toBeNull();
  });

  it("normalizes a user code from the query string", () => {
    expect(parseUserCode("?user_code=abcd-efgh")).toBe("ABCD-EFGH");
    expect(parseUserCode("user_code=%20wxyz-1234%20")).toBe("WXYZ-1234");
    expect(parseUserCode("?user_code=%20%20")).toBeNull();
    expect(parseUserCode("?other=x")).toBeNull();
  });
});

describe("claim stash", () => {
  it("round-trips only the fields a resume needs", () => {
    const storage = memoryStorage();
    const stash = createClaimStash(() => storage);
    stash.write({
      token: "osc_clm_x",
      presented: true,
      claimId: "clm1",
      principalId: "prn1",
    });
    expect(stash.read()).toEqual({
      token: "osc_clm_x",
      presented: true,
      claimId: "clm1",
      principalId: "prn1",
    });
    stash.clear();
    expect(stash.read()).toBeNull();
  });

  it("refuses malformed or partial records rather than half-resuming", () => {
    const storage = memoryStorage();
    const stash = createClaimStash(() => storage);
    storage.setItem("opensesame.claim", "not json");
    expect(stash.read()).toBeNull();
    storage.setItem("opensesame.claim", JSON.stringify({ token: "x" }));
    expect(stash.read()).toBeNull();
  });

  it("reads empty once the surface withdraws storage, e.g. a locked vault", () => {
    const storage = memoryStorage();
    let locked = false;
    const stash = createClaimStash(() => (locked ? null : storage));
    stash.write({ token: "osc_clm_x", presented: false });
    expect(stash.read()).not.toBeNull();
    locked = true;
    expect(stash.read()).toBeNull();
  });
});

describe("device approval", () => {
  const ok: typeof fetch = async () => new Response(null, { status: 204 });

  it("posts the trimmed code to the identity API", async () => {
    const fetchImpl = vi.fn(ok);
    await approveDevice({
      baseUrl: "http://id.example/",
      userCode: " abcd-efgh ",
      fetchImpl,
    });
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetch to be called");
    const [url, init] = call;
    if (!init) throw new Error("expected fetch init");
    // The trailing slash is normalized away rather than doubled.
    expect(url).toBe("http://id.example/v1/device/approve");
    expect(JSON.parse(String(init.body))).toEqual({ user_code: "abcd-efgh" });
    expect(init.credentials).toBe("include");
  });

  it("distinguishes the failures a human can act on", async () => {
    const status =
      (code: number): typeof fetch =>
      async () =>
        new Response(null, { status: code });
    const attempt = (code: number) =>
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "ABCD",
        fetchImpl: status(code),
      });
    await expect(attempt(401)).rejects.toThrow(/Sign in first/);
    await expect(attempt(404)).rejects.toThrow(/not found or has expired/);
    await expect(attempt(500)).rejects.toBeInstanceOf(CeremonyRequestError);
  });

  it("refuses an empty code without calling out", async () => {
    const fetchImpl = vi.fn(ok);
    await expect(
      approveDevice({
        baseUrl: "http://id.example",
        userCode: "   ",
        fetchImpl,
      }),
    ).rejects.toThrow(/Enter the user code/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
