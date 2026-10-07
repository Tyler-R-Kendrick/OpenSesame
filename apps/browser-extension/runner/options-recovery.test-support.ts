// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Load pure panel definitions with the fixture graph, not inside its timed hook.
// The actual options entrypoint still starts only after browser and DOM setup.
import "@opensesame/app-core/browser/security/bootstrap.js";
import {
  persistentBrowserOwner,
  persistentManagementBridge,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { expect, vi } from "vitest";
import { backupId, createRecoveryKey, sealBackup } from "./backup";
import { toB64 } from "./bytes";
import { clickSecurityAction } from "./test-support/security-action";
export function gate() {
  let finish: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
export function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === name,
  );
  if (!found) throw new Error(`Missing actual button ${name}`);
  return found;
}
export function field(id: string) {
  const found = document.getElementById(id);
  if (
    !(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)
  )
    throw new Error(`Missing field ${id}`);
  return found;
}
/** Wait for genuine rendered state; the unchanged test/hook deadline bounds it. */
function rendered(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!condition()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    if (condition()) {
      observer.disconnect();
      resolve();
    }
  });
}
export async function unlock(passwordValue: string, handle: string) {
  const password = document.querySelector('#security input[type="password"]');
  if (!(password instanceof HTMLInputElement))
    throw new Error("Missing genuine owner input");
  password.value = passwordValue;
  await clickSecurityAction(button("Unlock vault"));
  expect(document.querySelector("#security")?.textContent).toContain(
    "Vault open",
  );
  expect(
    document.querySelector("#production-controls")?.getAttribute("hidden"),
  ).toBeNull();
  await rendered(() =>
    Boolean(document.getElementById("held")?.textContent?.includes(handle)),
  );
  expect(document.getElementById("held")?.textContent).toContain(handle);
}
async function recoveryFixture() {
  const pair = await createRecoveryKey();
  const handle = "candidate:recovery-fixture";
  const candidate = "generated-recovery-fixture-value";
  const bytes = await sealBackup(
    pair.recipient,
    { handle, origin: "https://recovery.example" },
    candidate,
  );
  return { pair, handle, candidate, bytes };
}
export async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  // Independent public-recipient crypto neither reads nor admits the vault.
  const [owner, { pair, handle, candidate, bytes }] = await Promise.all([
    persistentBrowserOwner(),
    recoveryFixture(),
  ]);
  const bridge = persistentManagementBridge();
  const { rows, transport } = wireBrowser(bridge.runtime, bytes, handle);
  const optionsDocument = new DOMParser().parseFromString(
    readFileSync(join(__dirname, "../entrypoints/options/index.html"), "utf8"),
    "text/html",
  );
  document.replaceChild(
    document.importNode(optionsDocument.documentElement, true),
    document.documentElement,
  );
  const page = await import("../entrypoints/options/main");
  await rendered(
    () => document.querySelector('#security input[type="password"]') !== null,
  );
  expect(
    document.querySelector('#security input[type="password"]'),
  ).not.toBeNull();
  await unlock(owner.password, handle);
  field("token").value = "generated-local-host-session";
  await page.saveToken();
  expect(field("token").value).toBe("");
  field("reveal-key").value = JSON.stringify(pair.privateJwk);
  await enroll(owner.password);
  return { owner, bridge, handle, candidate, transport, pair, page, rows };
}

async function enroll(password: string) {
  const title = document.querySelector('input[aria-label="Note title"]');
  if (!(title instanceof HTMLInputElement))
    throw new Error("Missing actual note controls");
  title.value = "Owner recovery fixture";
  await clickSecurityAction(button("Add note"));
  expect(document.querySelector("#security")?.textContent).toContain(
    "Owner recovery fixture",
  );
  const labels = [...document.querySelectorAll("#security label")];
  const credentials: [string, string][] = [
    ["Current vault password", password],
    ["Retired vault password", "retired-recovery-synthetic-fixture"],
  ];
  for (const [label, value] of credentials) {
    const input = labels
      .find((node) => node.textContent === label)
      ?.querySelector("input");
    if (!(input instanceof HTMLInputElement))
      throw new Error(`Missing genuine ${label}`);
    input.value = value;
  }
  const response = document.querySelector(
    '#security select[aria-label="Retired password response"]',
  );
  const risk = document.querySelector('#security input[type="checkbox"]');
  if (
    !(response instanceof HTMLSelectElement) ||
    !(risk instanceof HTMLInputElement)
  )
    throw new Error("Missing genuine enrollment controls");
  response.value = "synthetic_decoy";
  risk.checked = true;
  await clickSecurityAction(button("Enroll retired password"));
  expect(document.querySelector("#security")?.textContent).toContain(
    "Retired credential trap enrolled.",
  );
}

interface Transport {
  failure: boolean;
  calls: number;
  hold: ReturnType<typeof gate> | undefined;
  started: ReturnType<typeof gate>;
}
function wireBrowser(
  runtime: ReturnType<typeof persistentManagementBridge>["runtime"],
  bytes: Uint8Array,
  handle: string,
) {
  const rows = new Map<string, string>();
  const transport: Transport = {
    calls: 0,
    hold: undefined,
    started: gate(),
    failure: false,
  };
  vi.stubGlobal("fetch", async () => {
    transport.calls += 1;
    const failure = transport.failure;
    transport.failure = false;
    const held = transport.hold;
    const response = Response.json({
      format: "opensesame-sync-page",
      version: 2,
      blobs: held
        ? [
            {
              id: "earlier",
              epoch: 2,
              ciphertext_epoch: 1,
              ciphertext_b64: toB64(new Uint8Array([1])),
            },
          ]
        : [
            {
              id: backupId(handle),
              epoch: 2,
              ciphertext_epoch: 1,
              ciphertext_b64: toB64(bytes),
            },
          ],
      next_after: held ? { epoch: 2, id: "earlier" } : null,
      has_more: !!held,
      serialized_bytes: 0,
      plaintext: null,
    });
    if (held) {
      transport.hold = undefined;
      transport.started.finish();
      await held.promise;
    }
    if (failure) throw new Error("Controlled failed response delivery");
    return response;
  });
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string | null) =>
          Object.fromEntries(
            [...rows].filter(([name]) => key === null || name === key),
          ),
        set: async (values: Record<string, string>) => {
          for (const [key, value] of Object.entries(values))
            rows.set(key, value);
        },
        remove: async (key: string) => {
          rows.delete(key);
        },
      },
    },
    runtime: {
      ...runtime,
      sendMessage: async () => ({
        session: true,
        privateAllowed: true,
        recovery: true,
        credentials: [],
        armed: [],
        lastPass: null,
        candidates: [
          {
            handle,
            origin: "https://recovery.example",
            state: "generated",
            createdAt: Date.now(),
          },
        ],
      }),
    },
  });
  return { rows, transport };
}
