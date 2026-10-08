/** @vitest-environment jsdom */
import {
  PWNED_PURPOSE,
  SECURITY_CHECKS_SUMMARY,
  TWO_FACTOR_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import { breachWatchSnapshot } from "@opensesame/app-core/lib/vault/health.js";
import {
  PWNED_RANGE_URL,
  SECURITY_CHECKS_IDLE,
  TWO_FACTOR_LIST_URL,
  clearSecurityWatch,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type AccountItem,
  createItem,
  manualPassword,
  newUri,
} from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

/** SHA-1 of "password": 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8. */
const RANGE = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:42\r\n0000:0";
const LIST = [["GitHub", { domain: "github.com", tfa: ["totp"] }]];

function login(name: string, password: string, uri: string): AccountItem {
  const base = createItem("account", name);
  if (base.kind !== "account") throw new Error("not an account");
  return {
    ...base,
    uris: [newUri(uri)],
    methods: [manualPassword(`${base.id}:password`, password, base.createdAt)],
  };
}

const ITEMS = [
  login("GitHub", "password", "https://github.com"),
  login("Shop", "a-long-unique-passphrase", "https://shop.example"),
];

const originalHooks = { ...vaultHooksSeams };
let status = "unlocked";

beforeEach(() => {
  status = "unlocked";
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), status, items: ITEMS }),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  clearSecurityWatch();
});

async function mountedPanel() {
  const t = createTestContext({
    egressResponse: () => new Response(null, { status: 500 }),
  });
  // Answer each declared purpose as its service would.
  const egress = t.ctx.egress;
  const ctx = {
    ...t.ctx,
    egress: {
      ...egress,
      async fetch(
        input: URL | string,
        init: RequestInit | undefined,
        meta: { capability: string; purpose: string },
      ) {
        await egress.fetch(input, init, meta);
        return String(input).startsWith(PWNED_RANGE_URL)
          ? new Response(RANGE)
          : Response.json(LIST);
      },
    },
  };
  const handle = await runtime.capabilityRuntime.activate(ctx);
  const [entry] = t.entries("settings-panel");
  if (!entry) throw new Error("no panel registered");
  const Panel: ComponentType = entry.Panel;
  render(<Panel />);
  return { t, handle };
}

describe("vault.security-checks runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the check on Settings › Vaults and in its Capabilities section", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.security-checks",
      kinds: ["settings-panel"],
      count: 2,
    });
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(breachWatchSnapshot()).toMatchObject({
      phase: "idle",
      label: SECURITY_CHECKS_IDLE,
    });
    expect(
      t
        .entries("settings-panel")
        .map((panel) => panel.category)
        .sort(),
    ).toEqual(["capabilities.feature-security-checks", "vaults"]);
    await handle.dispose();
    expect(breachWatchSnapshot().phase).toBe("off");
  });

  it("sends nothing until the key is pressed, then only what it declared", async () => {
    const { t, handle } = await mountedPanel();
    expect(t.egressCalls).toEqual([]);
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.getByText(SECURITY_CHECKS_SUMMARY)).toBeTruthy();
    expect(screen.getByText(SECURITY_CHECKS_IDLE)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Check logins against breaches and two-step sites",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("2 logins checked")).toBeTruthy(),
    );
    expect(
      screen.getByText(
        "1 of 2 passwords found in known breaches. 1 login could add an authenticator code.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Found in breaches 42 times: change this password"),
    ).toBeTruthy();
    expect(
      screen.getByText("This site takes an authenticator code; none is stored"),
    ).toBeTruthy();
    expect(t.egressCalls).toEqual([
      {
        input: `${PWNED_RANGE_URL}5BAA6`,
        capability: "vault.security-checks",
        purpose: PWNED_PURPOSE,
      },
      expect.objectContaining({
        capability: "vault.security-checks",
        purpose: PWNED_PURPOSE,
      }),
      {
        input: TWO_FACTOR_LIST_URL,
        capability: "vault.security-checks",
        purpose: TWO_FACTOR_PURPOSE,
      },
    ]);
    // No call carries a password, a hash beyond its prefix, or a site.
    for (const call of t.egressCalls) {
      const path = new URL(call.input).pathname;
      expect(path).not.toMatch(/a-long-unique|github|shop/);
      if (call.purpose === PWNED_PURPOSE)
        expect(path).toMatch(/^\/range\/[0-9A-F]{5}$/);
    }
    // GitHub: breached, and takes a code none is stored for. Shop: neither.
    const marks = screen
      .getAllByRole("img")
      .map((mark) => mark.getAttribute("aria-label"));
    expect(marks).toContain("Found in breaches 42 times: change this password");
    expect(marks).toContain(
      "This site takes an authenticator code; none is stored",
    );
    expect(screen.queryByText("Shop")).toBeNull();
    await handle.dispose();
  });

  it("cannot be pressed while the vault is locked", async () => {
    status = "locked";
    const { handle } = await mountedPanel();
    expect(
      screen
        .getByRole("button", {
          name: "Check logins against breaches and two-step sites",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    await handle.dispose();
  });
});
