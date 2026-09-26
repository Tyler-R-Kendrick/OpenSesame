/** @vitest-environment jsdom */
/**
 * The alias routes (ADR 0140 §1): `/delegate` and `/guest` draw nothing and
 * go to the base, where the unlock screen opens what they named. An address
 * boot never saw — an in-app navigation — is taken the way boot takes one:
 * a delegation bearer into Join's invite capture, never left in the address.
 */
import {
  peekGuestArrival,
  resetAliasArrivalForTests,
} from "@opensesame/app-core/lib/ceremony-aliases.js";
import {
  resetCapturedInviteForTests,
  takeCapturedInvite,
} from "@opensesame/app-core/lib/join/invite.js";
import { cleanup, render, waitFor } from "@testing-library/react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { AliasRoute } from "./AliasRoute.js";

const TOKEN = `osc_dlg_offer1.${"a".repeat(40)}`; // gitleaks:allow -- synthetic invite-shaped test vector

let seen = "";
function Where() {
  const location = useLocation();
  seen = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

function open(address: string) {
  history.replaceState(null, "", address);
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/guest" element={<AliasRoute />} />
        <Route path="/delegate" element={<AliasRoute />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </BrowserRouter>,
  );
}

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  resetAliasArrivalForTests();
  resetCapturedInviteForTests();
  seen = "";
});

describe("alias routes", () => {
  it("/delegate hands its bearer to Join and goes to the base", async () => {
    open(`/delegate#token=${TOKEN}`);
    await waitFor(() => expect(seen).toBe("/"));
    expect(location.href).not.toContain("osc_dlg_");
    expect(takeCapturedInvite()).toEqual({
      kind: "invite",
      invite: { token: TOKEN, endpoint: null },
    });
  });

  it("/guest notes the arrival and goes to the base", async () => {
    open("/guest");
    await waitFor(() => expect(seen).toBe("/"));
    expect(peekGuestArrival()).toBe(true);
  });
});
