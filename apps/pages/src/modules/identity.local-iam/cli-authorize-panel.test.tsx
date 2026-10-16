/** @vitest-environment jsdom */
/**
 * The Authorize sheet must never hang on "Reading CLI request…" or claim no
 * request is waiting when it could not check: on a shared-origin deployment
 * (GitHub Pages) the local-network fence throws, and a daemon that refuses
 * or cannot be read is an error, not an empty queue (#1193).
 */
import {
  CLI_APP_INTEGRATION_BEARER_KEY,
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { ownsWebStorageKey } from "@opensesame/app-core/lib/storage-ownership.js";
import { takeStorageWrites } from "@opensesame/app-core/test-host-storage-writes.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliAuthorizePanel } from "./cli-authorize-panel.js";

const BLOCKED =
  "Local CLI approval is blocked on this site. Open OpenSesame from your own deployment to check for CLI requests.";
const UNREADABLE = "Couldn't check for CLI requests.";
const EMPTY = "No CLI request is waiting.";
const LOADING = "Reading CLI request…";
const eligible = localNetworkFetchSeams.eligible;

function showPaired() {
  writeCliAppIntegrationBearer("A".repeat(43));
  return render(<CliAuthorizePanel />);
}

afterEach(() => {
  cleanup();
  clearCliAppIntegrationBearer();
  localNetworkFetchSeams.eligible = eligible;
  vi.unstubAllGlobals();
});

describe("Authorize CLI pending check", () => {
  it("keeps the pair control visible but disabled until a code is entered", async () => {
    render(<CliAuthorizePanel />);
    const pair = await screen.findByRole("button", {
      name: "Pair with the daemon",
    });
    expect(pair.hasAttribute("disabled")).toBe(true);
  });

  describe("paired daemon check", () => {
    afterEach(() => {
      // Pairing writes the CLI bearer under a key the storage-ownership
      // registry does not own yet (it predates this suite). Drain the recorded
      // writes so the setup's ownership assert judges only new keys, and pin
      // the known gap so any other unowned write still fails here.
      const unowned = takeStorageWrites().filter(
        (write) => !ownsWebStorageKey(write.key, write.area),
      );
      expect(unowned).toEqual([
        { area: "session", key: CLI_APP_INTEGRATION_BEARER_KEY },
      ]);
    });

    it("explains that local approval is blocked on this site instead of hanging or claiming an empty queue", async () => {
      // The test host stamps the shared-origin (GitHub Pages) profile, so the
      // real fence in localNetworkFetch throws before any fetch is attempted.
      showPaired();
      expect(await screen.findByText(BLOCKED)).toBeTruthy();
      expect(screen.queryByText(LOADING)).toBeNull();
      expect(screen.queryByText(EMPTY)).toBeNull();
    });

    it("says the check failed when the daemon refuses, not that no request is waiting", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("no", { status: 401 })),
      );
      showPaired();
      expect(await screen.findByText(UNREADABLE)).toBeTruthy();
      expect(screen.queryByText(EMPTY)).toBeNull();
    });

    it("still says no request is waiting when the daemon answers with an empty queue", async () => {
      localNetworkFetchSeams.eligible = () => true;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ pending: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      showPaired();
      expect(await screen.findByText(EMPTY)).toBeTruthy();
      expect(screen.queryByText(BLOCKED)).toBeNull();
      expect(screen.queryByText(UNREADABLE)).toBeNull();
    });
  });
});
