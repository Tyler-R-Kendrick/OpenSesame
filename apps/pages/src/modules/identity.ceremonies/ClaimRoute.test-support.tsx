/**
 * Shared `/claim` harness for the ClaimRoute suites: the address is scrubbed
 * into memory, and the route is drawn with or without a vault to return to.
 */
import { configureHost } from "@opensesame/app-core/host.js";
import {
  captureClaimArrivalFromPage,
  resetClaimArrivalForTests,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { CLAIM_NOTICE } from "@opensesame/app-core/lib/claims/route-model.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { cleanup, render } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { ClaimRoute } from "./ClaimRoute.js";

export const KEY = "a2V5LW1hdGVyaWFs"; // gitleaks:allow -- synthetic drop key test vector

export function arrive(address: string) {
  history.replaceState(null, "", address);
  captureClaimArrivalFromPage();
}

export function show() {
  return render(
    <MemoryRouter initialEntries={["/claim"]}>
      <ClaimRoute />
    </MemoryRouter>,
  );
}

/** `/claim` and a vault stub, so the way back is a real in-app navigation. */
export function showSitting() {
  return render(
    <MemoryRouter initialEntries={["/claim"]}>
      <Routes>
        <Route path="/claim" element={<ClaimRoute />} />
        <Route
          path="/vault"
          element={
            <>
              <h1>Vault home</h1>
              <Link to="/claim">Claim</Link>
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

export function trayed() {
  return listNotices().find((notice) => notice.id.startsWith(CLAIM_NOTICE));
}

export function resetClaimRoutePage() {
  configureHost(createTestHost());
}

export function cleanupClaimRoutePage() {
  cleanup();
  resetClaimArrivalForTests();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
}
