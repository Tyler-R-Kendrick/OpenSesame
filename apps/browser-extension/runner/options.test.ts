// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useClientAtRestKeys } from "@opensesame/browser-at-rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerService } from "./service";
import { RunnerSettings } from "./settings";
import { SealedKv } from "./store";
import { MemoryStore } from "./test-support/memory";
import { memorySecurityPort } from "./test-support/security-port";
import { RunnerVault } from "./vault";

// Key generation and sealed storage are real here; a loaded CI runner needs more than
// vi.waitFor's 1s default before the page has settled.
const eventually = (assertion: () => void) =>
  vi.waitFor(assertion, { timeout: 10_000 });

const html = readFileSync(
  join(__dirname, "../entrypoints/options/index.html"),
  "utf8",
);
const RP = "https://rp.example";

/** One device key for the page and the service, which load as separate module instances. */
const deviceKey = crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

interface Wired {
  store: MemoryStore;
  requested: { permissions?: string[]; origins?: string[] }[];
  messages: { type: string; origin?: string }[];
  granted: Set<string>;
}

/** The options page over a real runner service, with the browser stubbed under it. */
async function openPage(): Promise<Wired> {
  useClientAtRestKeys(() => deviceKey);
  const store = new MemoryStore();
  const kv = new SealedKv(store);
  const settings = new RunnerSettings(kv);
  const vault = new RunnerVault(kv);
  const granted = new Set<string>();
  const service = createRunnerService({
    settings,
    vault,
    grants: {
      has: async (origin) => granted.has(origin),
      revoke: async (origin) => void granted.delete(origin),
      privateAllowed: async () => true,
    },
    pagesFor: async () => null,
    closePage: async () => undefined,
    connect: async () => null,
  });
  const wired: Wired = { store, requested: [], messages: [], granted };
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string | null) =>
          key === null
            ? Object.fromEntries(store.rows)
            : Object.fromEntries(
                [...store.rows].filter(([name]) => name === key),
              ),
        set: async (rows: Record<string, string>) => {
          for (const [k, v] of Object.entries(rows)) store.rows.set(k, v);
        },
        remove: async (key: string) => void store.rows.delete(key),
      },
    },
    runtime: {
      connect: memorySecurityPort,
      sendMessage: async (message: { type: string; origin?: string }) => {
        wired.messages.push(message);
        if (message.type === "opensesame.runner.status")
          return service.status();
        if (message.type === "opensesame.runner.arm") {
          return { result: await service.arm(message.origin ?? "") };
        }
        await service.disarm(message.origin ?? "");
        return { result: "disarmed" };
      },
    },
    permissions: {
      request: async (want: { permissions?: string[]; origins?: string[] }) => {
        wired.requested.push(want);
        for (const origin of want.origins ?? [])
          granted.add(origin.replace("/*", ""));
        return true;
      },
    },
  });
  document.documentElement.innerHTML = html;
  vi.resetModules();
  const fresh = await import("@opensesame/browser-at-rest");
  fresh.useClientAtRestKeys(() => deviceKey);
  await import("../entrypoints/options/main");
  await eventually(() =>
    expect(document.querySelectorAll("#ready li")).toHaveLength(4),
  );
  return wired;
}

const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`[name="${name}"]`);

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("the options page", () => {
  it("says nothing is ready on a bare install", async () => {
    await openPage();
    const ready = [...document.querySelectorAll("#ready li")].map((li) => ({
      text: li.textContent,
      ok: li.getAttribute("data-ok"),
    }));
    expect(ready).toEqual([
      { text: "Host session", ok: "false" },
      { text: "Private window allowed (to prove a login)", ok: "true" },
      { text: "Recovery key pinned (to back a candidate up)", ok: "false" },
      { text: "Credentials held: 0", ok: "false" },
    ]);
  });

  it("saves a credential sealed, never in the clear, and clears the form", async () => {
    const wired = await openPage();
    const form = document.querySelector<HTMLFormElement>("#credential");
    for (const [name, value] of [
      ["origin", RP],
      ["username", "ada"],
      ["password", "hunter2-hunter2"],
    ] as const) {
      const input = field(name);
      if (input) input.value = value;
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await eventually(() => {
      expect(document.querySelector("#credentials")?.textContent).toContain(RP);
    });
    expect(field("password")?.value).toBe("");
    for (const [key, value] of wired.store.rows) {
      expect(value.startsWith("osc2."), key).toBe(true);
      expect(value).not.toContain("hunter2");
    }
  });

  it("refuses a credential for an origin the runner would not drive", async () => {
    const wired = await openPage();
    const input = field("origin");
    if (input) input.value = "http://rp.example";
    const pw = field("password");
    if (pw) pw.value = "x";
    document
      .querySelector("#credential")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(document.querySelector("#hint")?.textContent).toContain("origin");
    expect(wired.store.rows.size).toBe(0);
  });

  it("saves the Host session sealed and clears the field", async () => {
    const wired = await openPage();
    const token = document.querySelector<HTMLInputElement>("#token");
    if (token) token.value = "session-token-value";
    document.querySelector<HTMLButtonElement>("#token-save")?.click();
    await eventually(() => {
      expect(document.querySelector("#ready li")?.getAttribute("data-ok")).toBe(
        "true",
      );
    });
    expect(token?.value).toBe("");
    for (const value of wired.store.rows.values()) {
      expect(value).not.toContain("session-token-value");
      expect(value.startsWith("osc2.")).toBe(true);
    }
    expect(document.querySelector("#ready li")?.getAttribute("data-ok")).toBe(
      "true",
    );
  });

  it("asks the browser for one origin and scripting on the click, then arms it", async () => {
    const wired = await openPage();
    const input = field("origin");
    if (input) input.value = RP;
    const pw = field("password");
    if (pw) pw.value = "pw";
    document
      .querySelector("#credential")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await eventually(() => {
      expect(document.querySelector("#drive-origin option")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("#drive-arm")?.click();
    await eventually(() => {
      expect(document.querySelector("#armed")?.textContent).toContain(RP);
    });
    expect(wired.requested).toEqual([
      { permissions: ["scripting"], origins: [`${RP}/*`] },
    ]);
    expect(
      wired.messages.some(
        (m) => m.type === "opensesame.runner.arm" && m.origin === RP,
      ),
    ).toBe(true);
    expect(document.querySelector("#armed")?.textContent).toContain(RP);
  });

  it("requires vault owner admission before creating a recovery key on a bare install", async () => {
    await openPage();
    document.querySelector<HTMLButtonElement>("#recovery-create")?.click();
    await eventually(() =>
      expect(document.querySelector("#hint")?.textContent).toContain(
        "Create or unlock your vault",
      ),
    );
    expect(
      document.querySelector<HTMLElement>("#recovery-private-field")?.hidden,
    ).toBe(true);
    expect(
      document.querySelector<HTMLTextAreaElement>("#recovery-private")?.value,
    ).toBe("");
  });

  it("refuses a recovery key that is not a usable public key", async () => {
    await openPage();
    const area =
      document.querySelector<HTMLTextAreaElement>("#recovery-public");
    if (area) area.value = '{"kty":"oct","k":"AAAA"}';
    document.querySelector<HTMLButtonElement>("#recovery-pin")?.click();
    await eventually(() => {
      expect(document.querySelector("#hint")?.textContent).toContain(
        "public RSA-OAEP key",
      );
    });
  });
});
