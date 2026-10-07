import { SECURITY_PORT } from "@opensesame/app-core/browser/security/broker.js";
// @vitest-environment jsdom
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import type { SecurityPort } from "@opensesame/app-core/browser/security/runtime.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { hostPattern } from "../sites/patterns";
import { SITES_KEY, scriptId } from "../sites/sites";
import {
  OWN,
  POPUP,
  backgroundBrowser,
  event,
} from "./background-browser.fixture";
import { PUBLIC_VALUE, daemonWire } from "./background-daemon.fixture";
import { backgroundOwner } from "./background-owner.fixture";
import { FILL_COMMAND } from "./protocol";

const physical = vi.hoisted(() => ({ browser: {} }));
vi.mock("wxt/browser", () => ({ browser: physical.browser }));
async function fixture() {
  const browser = backgroundBrowser();
  const daemon = daemonWire();
  const owner = await backgroundOwner(browser, physical.browser);
  return {
    browser,
    daemon,
    owner,
    message: (op: "status" | "trigger" | "disable") => ({
      type: "opensesame.fill",
      op,
      securityPermit: owner.security.permit(),
    }),
    pair: () => ({
      type: "opensesame.fill.pair",
      securityPermit: owner.security.permit(),
    }),
    async enable() {
      const pattern = hostPattern(location.origin);
      if (!pattern) throw new Error("Expected genuine web origin");
      browser.permissions.add(pattern);
      return browser.ask({
        type: "opensesame.fill",
        op: "enable",
        origin: location.origin,
        securityPermit: owner.security.permit(),
      });
    },
    async close() {
      daemon.releaseAll();
      await browser.drain();
      await owner.close();
    },
  };
}

async function enabledFixture() {
  const f = await fixture();
  try {
    await f.enable();
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}

it("decodes the actual worker boundary and refuses foreign browser identities without daemon IO", async () => {
  const f = await fixture();
  try {
    await expect(
      f.browser.ask({ type: "opensesame.fill", op: "unknown" }),
    ).resolves.toEqual({ error: "bad_message" });
    expect(
      f.browser.dispatch({ type: "unrelated" }, POPUP).accepted,
    ).toBeUndefined();
    expect(
      f.browser.dispatch(
        { type: "opensesame.fill.pair", securityPermit: 42 },
        POPUP,
      ).accepted,
    ).toBeUndefined();
    await expect(
      f.browser.ask(f.pair(), { ...POPUP, id: "foreign" }),
    ).resolves.toEqual({ error: "forbidden_sender" });
    await expect(
      f.browser.ask(f.message("status"), {
        id: OWN,
        tab: { id: 7 },
        url: location.href,
      }),
    ).resolves.toEqual({ error: "forbidden_sender" });
    const disconnected = vi.fn();
    const foreign: SecurityPort = {
      name: SECURITY_PORT,
      sender: { id: "foreign", url: POPUP.url },
      onMessage: event<BoundaryValue>(),
      onDisconnect: event<void>(),
      postMessage: () => {},
      disconnect: disconnected,
    };
    f.browser.onConnect.emit(foreign);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
}, 20_000);

it("routes enabled status through the actual site registry, top-frame guard and daemon wire, then disables it", async () => {
  const f = await fixture();
  try {
    await expect(f.browser.ask(f.message("status"))).resolves.toEqual({
      origin: location.origin,
      enabled: false,
      references: [],
      passkey: false,
    });
    expect(f.daemon.requests).toEqual([]);
    await expect(f.enable()).resolves.toEqual({
      origin: location.origin,
      enabled: true,
      references: ["Controlled/reference"],
      passkey: false,
    });
    expect(f.browser.local.get(SITES_KEY)).toBe(
      JSON.stringify([location.origin]),
    );
    expect(
      f.browser.registrations.get(scriptId(location.origin)),
    ).toMatchObject({ matches: [hostPattern(location.origin)] });
    const request = f.daemon.requests[0];
    expect(request?.url).toBe("http://127.0.0.1:18790/v1/fill/match");
    expect(request?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ origin: location.origin }),
    });
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(headers.get("content-type")).toBe("application/json");
    await expect(f.browser.ask(f.message("disable"))).resolves.toEqual({
      origin: location.origin,
      enabled: false,
      references: [],
      passkey: false,
    });
    expect(f.browser.registrations.size).toBe(0);
    expect(f.browser.permissions.size).toBe(0);
    expect(f.browser.local.get(SITES_KEY)).toBe("[]");
    expect(f.browser.registrations.size).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);

it("withholds a held pairing response across genuine synthetic admission and fresh owner recovery", async () => {
  const f = await fixture();
  const held = f.daemon.hold("/v1/fill/pair");
  const pending = f.browser.ask(f.pair());
  try {
    await held.started;
    await f.owner.synthetic();
    const count = f.daemon.requests.length;
    await expect(f.browser.ask(f.pair())).resolves.toEqual({
      error: "vault_locked",
    });
    await expect(f.browser.ask(f.message("status"))).resolves.toEqual({
      error: "vault_locked",
    });
    expect(f.daemon.requests).toHaveLength(count);
    await f.owner.recover();
    held.release({ state: "pending", code: "OLDPAIR1" });
    await expect(pending).resolves.toEqual({ error: "vault_locked" });
    await expect(f.browser.ask(f.pair())).resolves.toEqual({
      state: "pending",
      code: "CURRENT1",
    });
  } finally {
    held.release({ state: "paired" });
    await Promise.allSettled([pending]);
    await f.close();
  }
}, 20_000);

it("does not return references from a held predecessor status after lock and fresh owner authentication", async () => {
  const f = await enabledFixture();
  const held = f.daemon.hold("/v1/fill/match");
  const pending = f.browser.ask(f.message("status"));
  try {
    await held.started;
    await f.owner.click("Lock vault");
    await f.owner.unlock();
    held.release({ references: ["Predecessor/private-reference"] });
    await expect(pending).resolves.toEqual({ error: "vault_locked" });
    await expect(f.browser.ask(f.message("status"))).resolves.toMatchObject({
      references: ["Controlled/reference"],
      enabled: true,
    });
  } finally {
    held.release({ references: [] });
    await Promise.allSettled([pending]);
    await f.close();
  }
}, 20_000);

it("withholds an old armed value and spends its nonce while a new real gesture fills only the guarded field", async () => {
  const f = await enabledFixture();
  const input = f.owner.field();
  const held = f.daemon.hold("/v1/fill");
  const pending = f.browser.ask(f.message("trigger"));
  try {
    await held.started;
    await f.owner.synthetic();
    await f.owner.recover();
    held.release({ field: "password", value: PUBLIC_VALUE });
    await expect(pending).resolves.toEqual({ error: "vault_locked" });
    expect(input.value).toBe("");
    expect(f.browser.observed[0]?.reply).toEqual({ refusal: "vault_locked" });
    const oldNonce = f.browser.observed[0]?.nonce;
    if (!oldNonce)
      throw new Error("The real guard never requested its armed nonce");
    await expect(
      f.browser.ask(
        {
          type: "opensesame.fill",
          op: "value",
          nonce: oldNonce,
          field: "password",
        },
        f.browser.content(),
      ),
    ).resolves.toEqual({ refusal: "unknown_gesture" });
    input.focus();
    const reply = await f.browser.ask(f.message("trigger"));
    expect(reply).toEqual({ outcome: "filled" });
    expect(input.value).toBe(PUBLIC_VALUE);
    expect(JSON.stringify(reply)).not.toContain(PUBLIC_VALUE);
    expect(JSON.stringify([...f.browser.local])).not.toContain(PUBLIC_VALUE);
    expect(JSON.stringify([...f.browser.session])).not.toContain(PUBLIC_VALUE);
    expect(
      f.daemon.requests.filter(
        (request) => new URL(request.url).pathname === "/v1/fill",
      ),
    ).toHaveLength(2);
  } finally {
    held.release({ field: "password", value: "" });
    await Promise.allSettled([pending]);
    await f.close();
  }
}, 20_000);

it("reports locked keyboard admission and physical daemon failure through the registered entrypoint", async () => {
  const f = await fixture();
  try {
    await f.owner.click("Lock vault");
    const outcome = deferred<string>();
    f.browser.toolbar.addListener(outcome.finish);
    f.browser.browser.commands.onCommand.emit("unrelated-command");
    expect(f.daemon.requests).toEqual([]);
    f.browser.browser.commands.onCommand.emit(FILL_COMMAND);
    await expect(outcome.promise).resolves.toBe(
      "OpenSesame autofill: vault locked",
    );
    await expect(f.browser.ask(f.pair())).resolves.toEqual({
      error: "vault_locked",
    });
    await f.owner.unlock();
    f.daemon.failNext();
    await expect(f.browser.ask(f.pair())).resolves.toEqual({
      error: "daemon_unreachable",
    });
    await expect(f.browser.ask(f.pair())).resolves.toEqual({
      state: "pending",
      code: "CURRENT1",
    });
  } finally {
    await f.close();
  }
}, 20_000);

it("reconciles real saved registrations when browser startup or permission removal invalidates a site", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const startup = deferred<void>();
    f.browser.permissionRemoved.addListener((pattern) => {
      if (pattern === hostPattern(location.origin)) startup.finish();
    });
    f.browser.registrations.clear();
    f.browser.browser.runtime.onStartup.emit();
    await startup.promise;
    await expect(f.browser.ask(f.message("status"))).resolves.toMatchObject({
      enabled: false,
      references: [],
    });
    await f.enable();
    const removed = deferred<void>();
    f.browser.permissionRemoved.addListener((pattern) => {
      if (pattern === hostPattern(location.origin)) removed.finish();
    });
    f.browser.permissions.clear();
    f.browser.browser.permissions.onRemoved.emit();
    await removed.promise;
    // The actual permission-removal port ran after registration removal.
    await expect(f.browser.ask(f.message("status"))).resolves.toMatchObject({
      enabled: false,
      references: [],
    });
    expect(f.browser.local.get(SITES_KEY)).toBe("[]");
    expect(f.browser.registrations.size).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);
