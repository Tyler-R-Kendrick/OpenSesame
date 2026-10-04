import { describe, expect, it } from "vitest";
import {
  MemoryLoginStore,
  MemoryReplayLedger,
  StorageLoginStore,
} from "./rp-store.js";
import {
  CLIENT,
  REDIRECT,
  T0,
  answerFor,
  codeOf,
  mint,
  relyingParty,
} from "./rp.fixture.js";
import { p256Pair } from "./test-keys.js";

/**
 * Login CSRF and session fixation: a response that is entirely valid for a
 * login must still sign nobody in unless the browser presenting it is the one
 * that started the login.
 */
describe("the browser that started a login", () => {
  it("is the only one a response can complete", async () => {
    const { rp } = relyingParty();
    const victim = await rp.startLogin();
    const attacker = await rp.startLogin();
    const keys = await p256Pair();
    // The attacker completes their own login at the OP and keeps the response.
    const attackerResponse = await mint(keys, { nonce: attacker.nonce });
    // They plant it in the victim's browser: valid state, valid token, and the
    // victim's own binding (the victim's cookie never saw the attacker's login).
    for (const binding of [victim.binding, "", "guessed"]) {
      expect(
        await codeOf(() =>
          rp.completeLogin(answerFor(attacker, attackerResponse, { binding })),
        ),
        `binding ${JSON.stringify(binding)}`,
      ).toBe("login_unknown");
    }
    // The attacker's login is untouched: its own browser can still finish it.
    const result = await rp.completeLogin(
      answerFor(attacker, attackerResponse),
    );
    expect(result.state).toBe(attacker.state);
  });

  it("leaves a login exactly as it was when somebody else knocks", async () => {
    const { rp } = relyingParty();
    const keys = await p256Pair();
    const started = await rp.startLogin();
    const token = await mint(keys, { nonce: started.nonce });
    // Three knocks with the wrong binding would burn a login that counted them.
    for (let knock = 0; knock < 5; knock += 1) {
      expect(
        await codeOf(() =>
          rp.completeLogin(answerFor(started, token, { binding: "other" })),
        ),
      ).toBe("login_unknown");
    }
    const result = await rp.completeLogin(answerFor(started, token));
    expect(result.state).toBe(started.state);
  });

  it("is also the only one that can report, and so close, a provider error", async () => {
    const { rp } = relyingParty();
    const started = await rp.startLogin();
    const forged = {
      response: `#error=access_denied&state=${started.state}`,
    };
    // One unauthenticated request carrying only the state must not end a login.
    for (const binding of ["", "attacker"]) {
      expect(
        await codeOf(() =>
          rp.completeLogin(
            answerFor(started, "unused", { ...forged, binding }),
          ),
        ),
      ).toBe("login_unknown");
    }
    const keys = await p256Pair();
    const result = await rp.completeLogin(
      answerFor(started, await mint(keys, { nonce: started.nonce })),
    );
    expect(result.state).toBe(started.state);
  });
});

/**
 * Each case is a response that is valid except for exactly one thing. The
 * control proves the rest is right, so every refusal below is that one check
 * doing its work: remove any check from `completeLogin` and its row fails.
 */
describe("every check fails alone", () => {
  type Case = {
    name: string;
    expected: string;
    change: (
      keys: Awaited<ReturnType<typeof p256Pair>>,
      nonce: string,
    ) => Promise<{
      idToken?: string;
      over?: Parameters<typeof answerFor>[2];
    }>;
  };
  const cases: Case[] = [
    {
      name: "binding",
      expected: "login_unknown",
      change: async () => ({ over: { binding: "someone-elses" } }),
    },
    {
      name: "redirect_uri",
      expected: "redirect_mismatch",
      change: async () => ({
        over: { receivedRedirectUri: `${REDIRECT}/elsewhere` },
      }),
    },
    {
      name: "nonce",
      expected: "nonce_mismatch",
      change: async (keys) => ({ idToken: await mint(keys, { nonce: "n2" }) }),
    },
    {
      name: "audience",
      expected: "audience_mismatch",
      change: async (keys, nonce) => ({
        idToken: await mint(keys, {
          nonce,
          audience: "local_11111111-1111-4111-8111-111111111111",
        }),
      }),
    },
    {
      name: "issuer",
      expected: "issuer_mismatch",
      change: async (keys, nonce) => ({
        idToken: await mint(keys, {
          nonce,
          issuer: "https://evil.example/OpenSesame/identity/siop",
        }),
      }),
    },
    {
      name: "freshness",
      expected: "token_expired",
      change: async (keys, nonce) => ({
        idToken: await mint(keys, { nonce, at: T0 - 7_200_000 }),
      }),
    },
  ];

  for (const row of cases) {
    it(`${row.name}: refused alone, accepted when it is right`, async () => {
      const keys = await p256Pair();
      const control = relyingParty();
      const controlStart = await control.rp.startLogin();
      const good = await mint(keys, { nonce: controlStart.nonce });
      expect(
        await codeOf(() =>
          control.rp.completeLogin(answerFor(controlStart, good)),
        ),
        "the control must succeed",
      ).toBe("no-refusal");

      const { rp } = relyingParty();
      const started = await rp.startLogin();
      const changed = await row.change(keys, started.nonce);
      const token =
        changed.idToken ?? (await mint(keys, { nonce: started.nonce }));
      expect(
        await codeOf(() =>
          rp.completeLogin(answerFor(started, token, changed.over)),
        ),
      ).toBe(row.expected);
    });
  }

  it("signature: refused alone", async () => {
    const keys = await p256Pair();
    const { rp } = relyingParty();
    const started = await rp.startLogin();
    const good = await mint(keys, { nonce: started.nonce });
    const flipped = `${good.slice(0, -4)}${good.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    expect(
      await codeOf(() => rp.completeLogin(answerFor(started, flipped))),
    ).toBe("signature_invalid");
    expect(CLIENT).toBeTruthy();
  });
});

describe("a store that is full", () => {
  it("refuses a new login and never evicts a live one", async () => {
    const store = new MemoryLoginStore(3, 600_000, () => T0);
    const { rp } = relyingParty({ store });
    const kept = [];
    for (let index = 0; index < 3; index += 1) kept.push(await rp.startLogin());
    expect(await codeOf(() => rp.startLogin())).toBe("capacity_exceeded");
    expect(store.size).toBe(3);
    // Every login that was accepted is still there.
    const keys = await p256Pair();
    for (const started of kept) {
      const result = await rp.completeLogin(
        answerFor(started, await mint(keys, { nonce: started.nonce })),
      );
      expect(result.state).toBe(started.state);
    }
  });

  it("makes room by pruning what has expired, from the oldest end", async () => {
    const clock = { now: T0 };
    const store = new MemoryLoginStore(2, 60_000, () => clock.now);
    const { rp, clock: rpClock } = relyingParty({ store });
    await rp.startLogin();
    await rp.startLogin();
    expect(await codeOf(() => rp.startLogin())).toBe("capacity_exceeded");
    clock.now = T0 + 61_000;
    rpClock.now = T0 + 61_000;
    expect(await codeOf(() => rp.startLogin())).toBe("no-refusal");
    expect(store.size).toBe(1);
  });

  it("costs the logins it removes, not the logins it holds", () => {
    const store = new MemoryLoginStore(100_000, 60_000, () => T0);
    const login = {
      clientId: CLIENT,
      binding: "b",
      nonce: "n",
      redirectUri: REDIRECT,
      createdAtMs: T0,
      attempts: 0,
    };
    for (let index = 0; index < 50_000; index += 1) {
      store.put(`s${index}`, login);
    }
    const started = performance.now();
    for (let index = 0; index < 20_000; index += 1) {
      store.put(`t${index}`, login);
    }
    // A scan per call would be a billion steps; this is milliseconds.
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("applies to the Storage-backed store the same way", () => {
    const entries = new Map<string, string>();
    const storage = {
      get length() {
        return entries.size;
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    };
    const clock = { now: T0 };
    const store = new StorageLoginStore(storage, 2, 60_000, () => clock.now);
    const login = {
      clientId: CLIENT,
      binding: "b",
      nonce: "n",
      redirectUri: REDIRECT,
      createdAtMs: T0,
      attempts: 0,
    };
    expect(store.put("a", login)).toBe(true);
    expect(store.put("b", login)).toBe(true);
    expect(store.put("c", login)).toBe(false);
    expect(entries.size).toBe(2);
    clock.now = T0 + 61_000;
    expect(store.put("c", { ...login, createdAtMs: clock.now })).toBe(true);
    expect(entries.size).toBe(1);
    // Foreign keys are not this store's to count or remove.
    entries.set("unrelated", "x");
    expect(store.put("d", { ...login, createdAtMs: clock.now })).toBe(true);
    expect(entries.has("unrelated")).toBe(true);
  });

  it("bounds the replay ledger by evicting its oldest entry once expired ones are gone", () => {
    const ledger = new MemoryReplayLedger(3);
    for (const key of ["a", "b", "c", "d"]) ledger.claim(key, T0 + 10_000, T0);
    expect(ledger.size).toBe(3);
    expect(ledger.has("a", T0)).toBe(false);
    expect(ledger.has("d", T0)).toBe(true);
  });
});
