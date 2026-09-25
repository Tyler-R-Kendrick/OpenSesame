// @vitest-environment jsdom
/**
 * The `/invoke/:kind` route model (ADR 0140 plan step 10): the query leaves
 * the address at once and is held in memory, the bare path it left behind
 * still answers with it, and a refusal is ceremony-kit's words.
 */
import { INVOCATION_WORDS } from "@opensesame/ceremony-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureInvocationArrivalFromPage,
  peekInvocationArrival,
  resetInvocationArrivalForTests,
} from "./invoke-link.js";
import { invocationEntry } from "./invoke-route.js";

afterEach(() => {
  resetInvocationArrivalForTests();
  history.replaceState(null, "", "/");
});

describe("invoke link capture", () => {
  it("takes the handle out of the address and keeps it in memory", () => {
    history.replaceState(null, "", "/invoke/mfa?user_code=abcd-1234");
    const arrival = captureInvocationArrivalFromPage();
    expect(location.pathname + location.search).toBe("/invoke/mfa");
    expect(arrival.kind).toBe("handoff");
    // The route mounting on the scrubbed path reads it again: same arrival.
    expect(captureInvocationArrivalFromPage()).toEqual(arrival);
    const entry = invocationEntry(peekInvocationArrival(), "/invoke/mfa");
    expect(entry.kind === "handoff" && entry.invocation.handle).toBe(
      "ABCD-1234",
    );
  });

  it("answers only for the kind it was read under", () => {
    history.replaceState(null, "", "/invoke/mfa?user_code=AB");
    captureInvocationArrivalFromPage();
    expect(invocationEntry(peekInvocationArrival(), "/invoke/oid4vp")).toEqual({
      kind: "refused",
      words: INVOCATION_WORDS.tooLong,
    });
  });

  it("refuses an unknown kind and scrubs it", () => {
    history.replaceState(null, "", "/invoke/totp?user_code=AB");
    expect(captureInvocationArrivalFromPage()).toEqual({
      kind: "refused",
      words: INVOCATION_WORDS.unknownKind,
    });
    expect(location.search).toBe("");
  });

  it("a reload of the bare path has no handle to hand on", () => {
    history.replaceState(null, "", "/invoke/mfa");
    const arrival = captureInvocationArrivalFromPage();
    expect(arrival.kind).toBe("refused");
  });

  it("leaves every other address alone", () => {
    history.replaceState(null, "", "/?code=abc&state=x");
    expect(captureInvocationArrivalFromPage()).toEqual({ kind: "none" });
    expect(location.search).toBe("?code=abc&state=x");
    expect(peekInvocationArrival().arrival).toEqual({ kind: "none" });
  });
});
