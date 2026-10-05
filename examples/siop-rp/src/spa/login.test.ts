import {
  type StorageLike,
  useClientAtRestKeys,
} from "@opensesame/browser-at-rest";
import {
  type MetadataFetch,
  buildSelfIssuedIdToken,
  ecP256JwkThumbprint,
  exportPublicEcP256Jwk,
  pagesOriginOf,
  pagesSiopIssuer,
  serializePagesSiopMetadata,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type SpaConfig,
  type SpaDeps,
  beginSignIn,
  finishSignIn,
} from "./login.js";
import { SealedLoginSlot } from "./sealed-login.js";

const PAGES = "https://pages.example/OpenSesame";
const CONFIG: SpaConfig = {
  pagesBase: PAGES,
  clientId: "local_00000000-0000-4000-8000-000000000001",
};
const ISSUER = pagesSiopIssuer(pagesOriginOf(PAGES));
const ORIGIN = "https://spa.example";

function memoryStorage(): StorageLike & { dump(): string } {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    dump: () => JSON.stringify([...entries]),
  };
}

beforeEach(async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  useClientAtRestKeys(async () => key);
});

function metadataFetch(body: string, type = "application/json"): MetadataFetch {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => type },
    text: async () => body,
  });
}

function browser(hash = "", fetch: MetadataFetch = metadataFetch("{}")) {
  const navigations: string[] = [];
  const scrubs: string[] = [];
  const storage = memoryStorage();
  // One slot per page load, as `main.ts` builds it.
  const slot = new SealedLoginSlot(storage);
  const deps = (at: string): SpaDeps => ({
    slot,
    fetch,
    page: { origin: ORIGIN, pathname: "/app/", search: "?tab=1", hash: at },
    navigate: (url) => {
      navigations.push(url);
    },
    scrub: (url) => {
      scrubs.push(url);
    },
  });
  return { deps, navigations, scrubs, hash, storage };
}

async function pagesAnswer(nonce: string, audience = CONFIG.clientId) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  const idToken = await buildSelfIssuedIdToken({
    profile: { kind: "dynamic", issuer: ISSUER },
    audience,
    nonce,
    publicJwk,
    signingKey: privateKey,
  });
  return { idToken, subject: await ecP256JwkThumbprint(publicJwk) };
}

const published = serializePagesSiopMetadata(pagesOriginOf(PAGES));

describe("single-page relying party", () => {
  it("reads the metadata, then sends the person to the endpoint it names", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    expect(page.navigations).toHaveLength(1);
    const url = new URL(page.navigations[0] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(ISSUER);
    // The page is its own callback: the address without query or fragment.
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/app/`);
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
  });

  it("does not navigate when the document is missing or is for another issuer", async () => {
    const spaFallback = browser(
      "",
      metadataFetch("<!doctype html>", "text/html"),
    );
    await expect(
      beginSignIn(CONFIG, spaFallback.deps("")),
    ).rejects.toMatchObject({ code: "malformed_metadata" });
    expect(spaFallback.navigations).toEqual([]);

    const other = serializePagesSiopMetadata(
      pagesOriginOf("https://evil.example/OpenSesame"),
    );
    const wrongIssuer = browser("", metadataFetch(other));
    await expect(
      beginSignIn(CONFIG, wrongIssuer.deps("")),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
    expect(wrongIssuer.navigations).toEqual([]);
  });

  it("completes a login that returns to the page, scrubbing the fragment first", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    const sent = new URL(page.navigations[0] ?? "");
    const { idToken, subject } = await pagesAnswer(
      sent.searchParams.get("nonce") ?? "",
    );
    const hash = `#${new URLSearchParams({ id_token: idToken, state: sent.searchParams.get("state") ?? "" })}`;
    const outcome = await finishSignIn(CONFIG, page.deps(hash));
    expect(outcome).toMatchObject({
      kind: "signed-in",
      result: { subject },
    });
    expect(page.scrubs).toEqual(["/app/?tab=1"]);
  });

  it("refuses the same response again after a reload", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    const sent = new URL(page.navigations[0] ?? "");
    const { idToken } = await pagesAnswer(sent.searchParams.get("nonce") ?? "");
    const hash = `#${new URLSearchParams({ id_token: idToken, state: sent.searchParams.get("state") ?? "" })}`;
    await finishSignIn(CONFIG, page.deps(hash));
    expect(await finishSignIn(CONFIG, page.deps(hash))).toEqual({
      kind: "refused",
      code: "login_unknown",
    });
  });

  it("refuses a wrong nonce, a wrong audience and an OP error", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    const state = new URL(page.navigations[0] ?? "").searchParams.get("state");
    const wrongNonce = await pagesAnswer("not-the-nonce");
    expect(
      await finishSignIn(
        CONFIG,
        page.deps(
          `#${new URLSearchParams({ id_token: wrongNonce.idToken, state: state ?? "" })}`,
        ),
      ),
    ).toEqual({ kind: "refused", code: "nonce_mismatch" });

    const second = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, second.deps(""));
    const sent = new URL(second.navigations[0] ?? "");
    const wrongAudience = await pagesAnswer(
      sent.searchParams.get("nonce") ?? "",
      "local_11111111-1111-4111-8111-111111111111",
    );
    expect(
      await finishSignIn(
        CONFIG,
        second.deps(
          `#${new URLSearchParams({ id_token: wrongAudience.idToken, state: sent.searchParams.get("state") ?? "" })}`,
        ),
      ),
    ).toEqual({ kind: "refused", code: "audience_mismatch" });

    const third = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, third.deps(""));
    const asked = new URL(third.navigations[0] ?? "");
    expect(
      await finishSignIn(
        CONFIG,
        third.deps(
          `#error=access_denied&state=${asked.searchParams.get("state")}`,
        ),
      ),
    ).toEqual({ kind: "refused", code: "provider_error" });
  });

  it("does nothing when the address carries no response", async () => {
    const page = browser();
    expect(await finishSignIn(CONFIG, page.deps(""))).toEqual({ kind: "none" });
    expect(await finishSignIn(CONFIG, page.deps("#"))).toEqual({
      kind: "none",
    });
    expect(page.scrubs).toEqual([]);
  });
});

function responseFor(sent: URL, idToken: string): string {
  return `#${new URLSearchParams({ id_token: idToken, state: sent.searchParams.get("state") ?? "" })}`;
}

describe("single-page relying party: the login is the tab's and is sealed", () => {
  it("leaves nothing in the clear in the tab's storage", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    const sent = new URL(page.navigations[0] ?? "");
    const dump = page.storage.dump();
    expect(dump).toContain("osc2.");
    for (const secret of [
      sent.searchParams.get("state") ?? "",
      sent.searchParams.get("nonce") ?? "",
      await page.deps("").slot.binding(),
      CONFIG.clientId,
    ]) {
      expect(secret.length).toBeGreaterThan(8);
      expect(dump, secret).not.toContain(secret);
    }
  });

  it("refuses a valid response in a tab that did not start the login, and leaves the real tab's login alone", async () => {
    const mine = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, mine.deps(""));
    const sent = new URL(mine.navigations[0] ?? "");
    const { idToken, subject } = await pagesAnswer(
      sent.searchParams.get("nonce") ?? "",
    );
    // A link carrying the person's own response, opened where no login began.
    const elsewhere = browser();
    expect(
      await finishSignIn(CONFIG, elsewhere.deps(responseFor(sent, idToken))),
    ).toEqual({ kind: "refused", code: "login_unknown" });
    expect(
      await finishSignIn(CONFIG, mine.deps(responseFor(sent, idToken))),
    ).toMatchObject({ kind: "signed-in", result: { subject } });
  });

  it("refuses a response when the tab's binding is not the login's", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    const sent = new URL(page.navigations[0] ?? "");
    const { idToken } = await pagesAnswer(sent.searchParams.get("nonce") ?? "");
    // Another document in this tab replaces the binding with one of its own.
    await new SealedLoginSlot(page.storage).bind("someone-else");
    const reloaded: SpaDeps = {
      ...page.deps(responseFor(sent, idToken)),
      slot: new SealedLoginSlot(page.storage),
    };
    expect(await finishSignIn(CONFIG, reloaded)).toEqual({
      kind: "refused",
      code: "login_unknown",
    });
  });

  it("does not let a forged #error close the login in a tab that has no binding", async () => {
    const mine = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, mine.deps(""));
    const sent = new URL(mine.navigations[0] ?? "");
    const forged = `#error=access_denied&state=${sent.searchParams.get("state")}`;
    expect(await finishSignIn(CONFIG, browser().deps(forged))).toEqual({
      kind: "refused",
      code: "login_unknown",
    });
    const { idToken, subject } = await pagesAnswer(
      sent.searchParams.get("nonce") ?? "",
    );
    expect(
      await finishSignIn(CONFIG, mine.deps(responseFor(sent, idToken))),
    ).toMatchObject({ kind: "signed-in", result: { subject } });
  });

  it("keeps one login: starting again replaces the one the tab was waiting on", async () => {
    const page = browser("", metadataFetch(published));
    await beginSignIn(CONFIG, page.deps(""));
    await beginSignIn(CONFIG, page.deps(""));
    const first = new URL(page.navigations[0] ?? "");
    const second = new URL(page.navigations[1] ?? "");
    const stale = await pagesAnswer(first.searchParams.get("nonce") ?? "");
    expect(
      await finishSignIn(CONFIG, page.deps(responseFor(first, stale.idToken))),
    ).toEqual({ kind: "refused", code: "login_unknown" });
    const fresh = await pagesAnswer(second.searchParams.get("nonce") ?? "");
    expect(
      await finishSignIn(CONFIG, page.deps(responseFor(second, fresh.idToken))),
    ).toMatchObject({ kind: "signed-in" });
  });

  it("does not leave, and writes nothing, where the origin can keep no key", async () => {
    useClientAtRestKeys(async () => {
      throw new Error("no IndexedDB");
    });
    const page = browser("", metadataFetch(published));
    await expect(beginSignIn(CONFIG, page.deps(""))).rejects.toThrow(
      /no at-rest key/u,
    );
    expect(page.navigations).toEqual([]);
    expect(page.storage.dump()).toBe("[]");
  });

  it("takes a loopback http Pages only when built for local development", async () => {
    const local = "http://127.0.0.1:8080/OpenSesame";
    const document = serializePagesSiopMetadata(pagesOriginOf(local));
    const strict = browser("", metadataFetch(document));
    await expect(
      beginSignIn({ ...CONFIG, pagesBase: local }, strict.deps("")),
    ).rejects.toBeInstanceOf(Error);
    expect(strict.navigations).toEqual([]);
    const dev = browser("", metadataFetch(document));
    await beginSignIn(
      { ...CONFIG, pagesBase: local, allowLoopbackHttp: true },
      dev.deps(""),
    );
    expect(dev.navigations).toHaveLength(1);
  });
});
