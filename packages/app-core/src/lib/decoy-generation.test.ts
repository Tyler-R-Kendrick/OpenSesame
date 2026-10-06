import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { resetRealmFixture } from "./__tests__/reset-realm-fixture.js";
import { decoyGuardedFetch, guardedFetchUsing } from "./decoy-fetch.js";
import {
  assertNotDecoySession,
  markDecoySession,
  withRealAuthority,
} from "./decoy-session.js";
import { hostFetch, identityFetch, identitySeams } from "./identity.js";

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

afterEach(() => {
  markDecoySession(false);
  vi.restoreAllMocks();
});

it("invalidates captured real authority after any generated sequence of realm resets", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
      (transitions) => {
        resetRealmFixture();
        const before = assertNotDecoySession();
        for (const active of transitions) markDecoySession(active);
        markDecoySession(false);
        expect(() => assertNotDecoySession(before)).toThrow(
          /authenticate again/,
        );
        if (transitions.includes(true))
          expect(() => assertNotDecoySession()).toThrow(/authenticate again/);
        else expect(() => assertNotDecoySession()).not.toThrow();
      },
    ),
    { seed: 1731006, numRuns: 250 },
  );
});

it("withholds raw and explicit SDK transport responses crossing decoy entry and exit", async () => {
  for (const explicit of [false, true]) {
    resetRealmFixture();
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>(() => response.promise);
    vi.spyOn(globalThis, "fetch").mockImplementation(transport);
    const pending = explicit
      ? guardedFetchUsing(transport, "https://production.example/")
      : decoyGuardedFetch("https://production.example/");
    markDecoySession(true);
    markDecoySession(false);
    response.finish(new Response("owner-only-data"));
    await expect(pending).rejects.toThrow(/authenticate again/);
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

it("withholds Host and Identity responses even after the synthetic realm has ended", async () => {
  for (const transport of ["host", "identity"]) {
    resetRealmFixture();
    const response = deferred<Response>();
    if (transport === "host")
      vi.spyOn(identitySeams, "hostFetch").mockImplementation(
        () => response.promise,
      );
    else
      vi.spyOn(identitySeams, "identityFetch").mockImplementation(
        () => response.promise,
      );
    const pending =
      transport === "host"
        ? hostFetch("/owner-data")
        : identityFetch("/owner-data");
    markDecoySession(true);
    markDecoySession(false);
    response.finish(new Response("owner-only-data"));
    await expect(pending).rejects.toThrow(/authenticate again/);
  }
});

it("rejects rejected descendants from a previous realm without exposing their underlying error", async () => {
  const pending = withRealAuthority(async () => {
    markDecoySession(true);
    markDecoySession(false);
    throw new Error("owner-only-error-details");
  });
  await expect(pending).rejects.toThrow(/authenticate again/);
  await expect(pending).rejects.not.toThrow("owner-only-error-details");
});

it("allows an unchanged real realm but invalidates pending work on lock even without a decoy", async () => {
  await expect(
    withRealAuthority(async () => "current owner result"),
  ).resolves.toBe("current owner result");
  const response = deferred<string>();
  const pending = withRealAuthority(() => response.promise);
  markDecoySession(false);
  response.finish("previous owner result");
  await expect(pending).rejects.toThrow(/authenticate again/);
});
