// @vitest-environment jsdom
import { openFromRest, useClientAtRestKeys } from "@opensesame/browser-at-rest";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  button,
  hintAfter,
  node,
  popupFixture,
  rendered,
  signal,
} from "./popup-dom.fixture";
import { clickSecurityAction } from "./test-support/security-action";

let f: Awaited<ReturnType<typeof popupFixture>>;
beforeAll(async () => {
  f = await popupFixture();
});
afterEach(async () => {
  if (f) {
    await f.lock();
    await f.drain();
  }
});
afterAll(async () => {
  if (f) await f.close();
});

function removedWorkflows() {
  expect(document.querySelectorAll("button[data-workflow]")).toHaveLength(0);
  expect(
    document.querySelectorAll(
      '[aria-label="Vault tasks"], [aria-label="Authorization tasks"]',
    ),
  ).toHaveLength(0);
  expect(document.querySelectorAll("a[href]")).toHaveLength(0);
  for (const name of [
    "Create a credential",
    "Read a credential privately",
    "Compare a login password",
  ])
    expect(
      [...document.querySelectorAll("button")].some(
        (control) => control.textContent === name,
      ),
    ).toBe(false);
}

it("mounts the actual popup locked and denies programmatically clicked production actions", async () => {
  expect(node("production-controls", HTMLDivElement).hidden).toBe(true);
  removedWorkflows();
  for (const name of ["Save host", "Retry"])
    await hintAfter(button(name), "Unlock the real vault to continue.");
  await hintAfter(
    node("security-open", HTMLButtonElement),
    "Unlock the real vault to continue.",
  );
  await f.drain();
  expect(f.gets).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.requests).toEqual([]);
  expect(f.opened).toEqual([]);
  expect(f.optionsOpened()).toBe(0);
});

it("loads real-owner defaults, public health/cursor states and security options with removed workflow UI absent", async () => {
  await f.unlock();
  expect(node("production-controls", HTMLDivElement).hidden).toBe(false);
  expect(node("host", HTMLInputElement).value).toBe("http://127.0.0.1:8787");
  expect(node("status", HTMLUListElement).textContent).toContain(
    "public-device @ epoch 4",
  );
  expect(f.requests.at(-1)?.securityPermit).toEqual(expect.any(String));
  // Await physical port completion, not an unrelated DOM mutation.
  button("Security settings").click();
  await f.optionsCalled;
  expect(f.optionsOpened()).toBe(1);
  removedWorkflows();
  expect(f.opened).toEqual([]);
  const previousHealth = f.requests.length;
  const completed = rendered(
    () =>
      f.requests.length > previousHealth &&
      node("status", HTMLUListElement).textContent !== "Checking…",
  );
  button("Retry").click();
  await completed;
  expect(f.requests.at(-1)?.type).toBe("opensesame.health");
  expect(f.requests.at(-1)?.securityPermit).toEqual(expect.any(String));
  expect(node("status", HTMLUListElement).textContent).toContain(
    "Host API (http://127.0.0.1:8787): up",
  );
  expect(node("status", HTMLUListElement).textContent).toContain(
    "Daemon: available",
  );
  expect(f.opened).toEqual([]);
});

it("shows unavailable status, API errors and transport errors without accepting metadata as authority", async () => {
  await f.unlock();
  f.transport.response = {
    health: { ok: false },
    hostBase: "http://127.0.0.1:9191",
  };
  await hintAfter(
    button("Retry"),
    "Start the Host API on http://127.0.0.1:9191, then retry.",
  );
  expect(node("status", HTMLUListElement).textContent).toContain(
    "unavailable (optional)",
  );
  expect(node("status", HTMLUListElement).textContent).toContain("n/a");
  f.transport.response = { error: "Controlled worker error" };
  await hintAfter(button("Retry"), "Controlled worker error");
  expect(node("status", HTMLUListElement).textContent).toBe(
    "Could not load status",
  );
  f.transport.reject = "controlled transport rejection";
  await hintAfter(button("Retry"), "Background worker unavailable.");
  f.transport.response = { health: { ok: true } };
});

it("rejects external bases and saves only real AES envelopes for normalized loopback inputs", async () => {
  await f.unlock();
  const before = f.writes.length;
  node("host", HTMLInputElement).value = "https://attacker.example";
  await hintAfter(
    button("Save host"),
    "Host API must be a loopback URL (http://127.0.0.1:8787).",
  );
  expect(f.writes).toHaveLength(before);
  node("host", HTMLInputElement).value = " http://127.0.0.1:9191/ ";
  const previousHealth = f.requests.length;
  const healthCompleted = rendered(
    () =>
      f.requests.length > previousHealth &&
      node("status", HTMLUListElement).textContent !== "Checking…",
  );
  button("Save host").click();
  // Metadata write has no DOM change until the genuine save completion hint.
  await rendered(
    () => node("hint", HTMLParagraphElement).textContent === "Host API saved.",
  );
  await healthCompleted;
  expect(f.writes).toHaveLength(before + 1);
  const envelope = f.rows.get("hostApiBase");
  expect(envelope).toMatch(/^osc2\./);
  expect(envelope).not.toContain("9191");
  expect(
    await openFromRest("chrome.storage.local", "hostApiBase", envelope ?? ""),
  ).toBe("http://127.0.0.1:9191");
});

it("uses legacy and unreadable-storage defaults, and refuses plaintext persistence without a real key", async () => {
  f.rows.set("hostApiBase", "http://127.0.0.1:9494");
  await f.unlock();
  expect(node("host", HTMLInputElement).value).toBe("http://127.0.0.1:9494");
  await f.lock();
  f.transport.storageFailure = true;
  await f.unlock();
  expect(node("host", HTMLInputElement).value).toBe("http://127.0.0.1:8787");
  f.transport.storageFailure = false;
  useClientAtRestKeys(() =>
    Promise.reject(new Error("Physical key store unavailable")),
  );
  const before = f.writes.length;
  node("host", HTMLInputElement).value = "http://127.0.0.1:9595";
  await hintAfter(
    button("Save host"),
    "This browser cannot keep the Host API setting.",
  );
  expect(f.writes).toHaveLength(before);
  expect(f.rows.get("hostApiBase")).toBe("http://127.0.0.1:9494");
  useClientAtRestKeys(() => Promise.resolve(f.key));
});

it("withholds an accepted save after original-owner revocation and fresh same-password reauthentication", async () => {
  await f.unlock();
  const entered = signal<void>();
  const release = signal<void>();
  useClientAtRestKeys(async () => {
    entered.finish();
    await release.promise;
    return f.key;
  });
  const before = f.writes.length;
  node("host", HTMLInputElement).value = "http://127.0.0.1:9696";
  button("Save host").click();
  try {
    await entered.promise;
    await f.lock();
    await f.unlock();
    const refused = rendered(
      () =>
        node("hint", HTMLParagraphElement).textContent ===
        "Unlock the real vault to continue.",
    );
    release.finish();
    await refused;
    expect(f.writes).toHaveLength(before);
  } finally {
    release.finish();
    useClientAtRestKeys(() => Promise.resolve(f.key));
    await f.drain();
  }
});

it("routes an actually enrolled retired password to synthetic UI with no popup production dispatch", async () => {
  await f.unlock();
  await rendered(() =>
    [...document.querySelectorAll("#security label")].some(
      (l) => l.textContent === "Current vault password",
    ),
  );
  const retiredPasswords: [string, "reject" | "synthetic_decoy"][] = [
    ["public-retired-popup-reject-fixture", "reject"],
    ["public-retired-popup-fixture", "synthetic_decoy"],
  ];
  for (const [password, mode] of retiredPasswords) {
    const credentials: [string, string][] = [
      ["Current vault password", f.owner.password],
      ["Retired vault password", password],
    ];
    for (const [label, value] of credentials) {
      const field = [...document.querySelectorAll("#security label")]
        .find((l) => l.textContent === label)
        ?.querySelector("input");
      if (!(field instanceof HTMLInputElement))
        throw new Error(`Missing real enrollment ${label}`);
      field.value = value;
    }
    const response = document.querySelector(
      '#security select[aria-label="Retired password response"]',
    );
    const risk = document.querySelector('#security input[type="checkbox"]');
    if (
      !(response instanceof HTMLSelectElement) ||
      !(risk instanceof HTMLInputElement)
    )
      throw new Error("Missing actual enrollment controls");
    if (mode === "reject") expect(response.value).toBe("reject");
    response.value = mode;
    risk.checked = true;
    await clickSecurityAction(button("Enroll retired password"));
    expect(document.querySelector("#security")?.textContent).toContain(
      "Retired credential trap enrolled.",
    );
  }
  await f.lock();
  const calls = [
    f.gets.length,
    f.writes.length,
    f.requests.length,
    f.opened.length,
    f.optionsOpened(),
  ];
  const input = document.querySelector('#security input[type="password"]');
  if (!(input instanceof HTMLInputElement))
    throw new Error("Missing actual retired-password unlock control");
  input.value = "public-retired-popup-reject-fixture";
  await clickSecurityAction(button("Unlock vault"));
  expect(document.querySelector("#security")?.textContent).toContain(
    "The password did not open this vault.",
  );
  expect(node("production-controls", HTMLDivElement).hidden).toBe(true);
  removedWorkflows();
  await f.unlock("public-retired-popup-fixture");
  expect(document.querySelector("#security")?.textContent).toContain(
    "Example account",
  );
  expect(node("production-controls", HTMLDivElement).hidden).toBe(true);
  removedWorkflows();
  for (const name of ["Save host", "Retry"])
    await hintAfter(button(name), "Unlock the real vault to continue.");
  await hintAfter(
    node("security-open", HTMLButtonElement),
    "Unlock the real vault to continue.",
  );
  expect([
    f.gets.length,
    f.writes.length,
    f.requests.length,
    f.opened.length,
    f.optionsOpened(),
  ]).toEqual(calls);
  await f.lock();
  await f.unlock();
  expect(node("production-controls", HTMLDivElement).hidden).toBe(false);
  removedWorkflows();
});
