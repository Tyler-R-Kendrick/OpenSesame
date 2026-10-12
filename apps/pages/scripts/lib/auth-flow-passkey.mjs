// Passkey seal over a CDP virtual WebAuthn authenticator, two walks.
//
// Happy path: Chrome's virtual authenticator never emits PRF results, so the
// page's extension output is stubbed the way
// packages/app-core/src/lib/local-passkeys.test.ts stubs it — a deterministic
// 32-byte value derived from the eval salt of the in-flight ceremony. Seal
// with passkey lands inside the app; lock; Unlock with passkey opens it again.
//
// PRF off: no stub, so the ceremony fails closed with prf_missing_output. The
// failure must not read as a no-op: the corner shows the notice's card with
// the PRF-missing message — no sheet, so the caret keeps its field — while
// the seal screen stays put. Walked on both ctap2 and ctap2_1 — neither
// virtual protocol emits PRF results.
import { passTheDoor } from "./front-door.mjs";

async function addVirtualAuthenticator(context, page, protocol) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const options = (value) => ({
    options: {
      protocol: value,
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      options(protocol),
    );
    return { authenticatorId, protocol };
  } catch {
    // An older Chromium knows ctap2 only; the PRF absence is the same there.
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      options("ctap2"),
    );
    return { authenticatorId, protocol: "ctap2" };
  }
}

async function stubPrfResults(page) {
  await page.addInitScript(() => {
    window.__prfPending = null;
    const readResults = PublicKeyCredential.prototype.getClientExtensionResults;
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      const base = readResults.call(this);
      if (!window.__prfPending) return base;
      return { ...base, prf: { results: { first: window.__prfPending } } };
    };
    for (const verb of ["create", "get"]) {
      const call = navigator.credentials[verb].bind(navigator.credentials);
      navigator.credentials[verb] = async (options) => {
        const salt = options?.publicKey?.extensions?.prf?.eval?.first;
        if (salt) {
          window.__prfPending = await crypto.subtle.digest("SHA-256", salt);
        }
        return call(options);
      };
    }
  });
}

async function reachSealScreen(page, ORIGIN, BASE) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page
    .getByRole("heading", { name: "Seal this device" })
    .waitFor({ timeout: 15000 });
}

async function unlockWithPasskey(page, check, snap, stepName) {
  const unlocked = async () =>
    page
      .getByRole("link", { name: "New item", exact: true })
      .waitFor({ timeout: 20000 })
      .then(
        () => true,
        () => false,
      );
  await page.getByRole("button", { name: "Unlock with passkey" }).click();
  check(await unlocked(), `${stepName}: Unlock with passkey opened the vault`);
  await snap(page, `${stepName}-unlocked-again`);
}

export async function passkeyJourneys({
  browser,
  newPage,
  check,
  snap,
  setStep,
  lock,
  ORIGIN,
  BASE,
}) {
  // ---- 4: PRF results stubbed — seal and unlock with a passkey
  {
    setStep("4-passkey-prf");
    const { page, context } = await newPage(browser);
    await stubPrfResults(page);
    await addVirtualAuthenticator(context, page, "ctap2_1");
    await reachSealScreen(page, ORIGIN, BASE);
    const sealed = await snap(page, "4-passkey-seal-screen");
    check(
      (await page
        .getByRole("tab", { name: "Passkey" })
        .getAttribute("aria-selected")) === "true",
      "the passkey tab leads the first-run seal",
    );
    check(
      /the PIN tab works on any device/.test(sealed),
      "the seal copy points at the PIN tab fallback",
    );
    await page
      .getByLabel("I understand this vault cannot be recovered.", {
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Seal with passkey" }).click();
    const inside = await page
      .getByRole("link", { name: "New item", exact: true })
      .waitFor({ timeout: 20000 })
      .then(
        () => true,
        () => false,
      );
    check(inside, "Seal with passkey landed inside the app");
    await snap(page, "4-passkey-sealed");
    await lock(page);
    const locked = await snap(page, "4-passkey-locked");
    check(/^Unlock$/m.test(locked), "lock lands on Unlock");
    check(
      (await page.getByRole("tab", { name: "Passkey" }).count()) === 1,
      "the passkey tab is offered on the locked screen",
    );
    await unlockWithPasskey(page, check, snap, "4-passkey-prf");
    await context.close();
  }

  // ---- 5: PRF off — the failure is on screen, the seal screen stays
  for (const protocol of ["ctap2", "ctap2_1"]) {
    setStep(`5-passkey-no-prf-${protocol}`);
    const { page, context } = await newPage(browser);
    await addVirtualAuthenticator(context, page, protocol);
    await reachSealScreen(page, ORIGIN, BASE);
    await page
      .getByLabel("I understand this vault cannot be recovered.", {
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "Seal with passkey" }).click();
    const card = page.locator(".notice-corner .notice-card--err");
    const shown = await card.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    );
    check(shown, "the failure's card is on screen, not only a pip on the bell");
    const body = await snap(page, `5-passkey-no-prf-${protocol}`);
    check(
      /did not return a WebAuthn PRF result/.test(
        shown ? ((await card.textContent()) ?? "") : "",
      ),
      "the card carries the PRF-missing message",
    );
    check(
      (await page.getByRole("dialog", { name: "Notifications" }).count()) === 0,
      "the tray sheet stays closed — the caret keeps its field",
    );
    check(
      (await page
        .getByRole("heading", { name: "Seal this device" })
        .count()) === 1,
      "still on Seal this device — the failure was not silent",
    );
    await context.close();
  }
}
