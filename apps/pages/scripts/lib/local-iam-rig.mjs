/**
 * The rig behind the browser-local IAM suites (`verify-local-iam.mjs`,
 * `verify-device-inbox.mjs`): a disposable fixture that seeds an encrypted
 * vault with a person, an agent, an organization and a registered
 * application, a relying party on another origin whose page drives the real
 * SDKs, and the keyboard-only steps that open and approve the consent popup.
 *
 * Split out of the first suite so the second runs the very same sign-in rather
 * than a copy of it. Nothing here asserts a product claim; the suites do.
 */

import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  LOCAL_IAM_CAPABILITIES,
  chooseCapabilities,
} from "./local-access-journey.mjs";
import { expect } from "./patient-expect.mjs";

export const root = fileURLToPath(new URL("../../../..", import.meta.url));

/** Bundle an entry as one browser script, for a disposable page to run. */
export async function bundle(entry, name) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    define: {
      "process.env.NODE_DEBUG_NATIVE": "false",
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: {
        "@opensesame/os-domain": `${root}/packages/os-domain/src/browser.ts`,
      },
    },
    build: {
      write: false,
      target: "es2022",
      lib: { entry, name, formats: ["iife"] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  return output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
}

function rpHtml(app, agent, { issuerUrl, rp, origin }) {
  return `<!doctype html><html><body><button id="signin">Sign in locally</button><button id="check">Check session</button><button id="revoke">Revoke</button><output id="status">Signed out</output><script src="/client.js"></script><script src="/agent.js"></script><script>
const status = document.getElementById('status'); let session;
function refuse(message,error) {status.textContent=message;status.dataset.reason=['authorization_unavailable','invalid_response','invalid_identity','local_session_unavailable','local_session_closed','popup_closed','authorization_expired','local_request_timeout','local_handshake_timeout','agent_authentication_failed'].includes(error.message)?error.message:'other';}
document.getElementById('signin').onclick = () => { delete status.dataset.reason; status.textContent='Waiting'; const profile={authorizationEndpoint:${JSON.stringify(issuerUrl)},clientId:${JSON.stringify(app)},redirectUri:${JSON.stringify(`${rp}/callback`)},scopes:['openid','records:read']}; const agentId=${JSON.stringify(agent ?? null)}; if(agentId)profile.agent={principalId:agentId,keyId:localAgentKey.keyId,signChallenge:challenge=>{status.dataset.proof="requested";return localAgentKey.signChallenge(challenge,${JSON.stringify(origin)},agentId);}}; LocalRpSdk.signInLocalBrowser(profile).then(value=>{session=value;status.textContent='Signed in locally: '+value.identity.subject;},error=>refuse('Sign-in refused',error)); };
document.getElementById('check').onclick = () => {session.check('records:read').then(()=>{status.textContent='Session active';},error=>refuse('Session refused',error));};
document.getElementById('revoke').onclick = () => {session.revoke().then(()=>{status.textContent='Revoked';},error=>refuse('Revocation refused',error));};
</script></body></html>`;
}

/** Press Tab until `target` holds focus: the keyboard's own road to a control. */
export async function tabTo(page, target) {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard could not reach consent control");
}

export async function authenticator(page, credentials = []) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  for (const credential of credentials)
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  return { cdp, authenticatorId };
}

function openConsentWith(harness) {
  return async function openConsent(
    page,
    context,
    credentials,
    width,
    agentMode = false,
  ) {
    const opening = context.waitForEvent("page");
    await tabTo(
      page,
      page.getByRole("button", { name: "Sign in locally", exact: true }),
    );
    await page.keyboard.press("Enter");
    const popup = await opening;
    popup.on("pageerror", (error) =>
      harness.record("PAGE-ERROR", error.message),
    );
    await popup.setViewportSize({ width, height: 900 });
    const device = await authenticator(popup, credentials);
    const password = popup.getByLabel("Password", { exact: true });
    await expect(password).toBeVisible();
    await tabTo(popup, password);
    await expect(password).toBeFocused();
    await popup.keyboard.insertText("Cedar-lantern-47-river!");
    await expect(password).toHaveValue("Cedar-lantern-47-river!");
    await popup.keyboard.press("Enter");
    await expect(
      popup.getByRole("heading", {
        name: agentMode
          ? "Authorize agent access to Test application"
          : "Sign in to Test application",
      }),
    ).toBeVisible();
    return { popup, device };
  };
}

function approveConsentWith(captures) {
  return async function approveConsent(page, popup, width, agentMode = false) {
    await expect(page.locator("output")).toHaveText("Waiting");
    if (agentMode)
      await expect(popup.getByText("Agent requesting access:")).toContainText(
        "Local test agent",
      );
    await tabTo(
      popup,
      popup.getByLabel(agentMode ? "Approving person" : "Person", {
        exact: true,
      }),
    );
    await popup.keyboard.press("ArrowDown");
    await popup.keyboard.press("Enter");
    await tabTo(
      popup,
      popup.getByRole("button", { name: "Verify with passkey", exact: true }),
    );
    await popup.keyboard.press("Enter");
    const allow = popup.getByRole("button", {
      name: agentMode ? "Allow agent access" : "Allow application",
      exact: true,
    });
    await expect(allow).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("output")).toHaveText("Waiting");
    await tabTo(popup, allow);
    await popup.locator(".wordmark").evaluateAll(async (nodes) => {
      await Promise.all(
        nodes.flatMap((node) =>
          node
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        ),
      );
    });
    await popup.screenshot({
      path: `${captures}/local-${agentMode ? "agent-" : ""}consent-${width}.png`,
      fullPage: true,
    });
    await expect(allow).toBeFocused();
    await popup.keyboard.press("Enter");
  };
}

/** Seed the vault in a disposable page and return what the fixture made. */
async function seedVault({ harness, browser, origin, fixture }) {
  const { page, context } = await harness.newPage(browser);
  // Keep the VM's observed wall-clock corrections out of the happy-path
  // fixture. Freeze wall time only; real timers and performance deadlines
  // still advance. assertClockRollbackRefusal moves wall time backwards
  // explicitly.
  await context.clock.setFixedTime(new Date("2026-09-10T00:00:00Z"));
  await context.route(`${origin}/fixture`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Disposable IAM fixture</body></html>",
    }),
  );
  await page.goto(`${origin}/fixture`);
  const device = await authenticator(page);
  await page.addScriptTag({ content: fixture });
  if (!(await page.evaluate(() => Boolean(globalThis.LocalIamFixture))))
    throw new Error(
      `Fixture did not load: ${JSON.stringify(harness.log.filter((row) => row.kind === "PAGE-ERROR"))}`,
    );
  const identities = await page.evaluate(() => LocalIamFixture.seed());
  const { credentials } = await device.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: device.authenticatorId,
  });
  return { seedPage: page, context, identities, credentials };
}

function seedJourneyWith(deps) {
  const { rp, issuerUrl, origin, sdk, agentSdk } = deps;
  return async function seedJourney(
    agentMode,
    capabilities = LOCAL_IAM_CAPABILITIES,
  ) {
    const { seedPage, context, identities, credentials } =
      await seedVault(deps);
    const page = await context.newPage();
    const html = rpHtml(identities.app, agentMode ? identities.agent : null, {
      issuerUrl,
      rp,
      origin,
    });
    await context.route(`${rp}/**`, (route) =>
      route.fulfill(
        route.request().url().endsWith("/client.js")
          ? { contentType: "text/javascript", body: sdk }
          : route.request().url().endsWith("/agent.js")
            ? { contentType: "text/javascript", body: agentSdk }
            : { contentType: "text/html", body: html },
      ),
    );
    await page.goto(`${rp}/`);
    if (agentMode) {
      const publicKey = await page.evaluate(async () => {
        globalThis.localAgentKey = await LocalAgentSdk.createLocalAgentKey();
        return globalThis.localAgentKey.publicKey;
      });
      await seedPage.evaluate(
        ({ principalId, publicKey }) =>
          LocalIamFixture.enrollAgent(principalId, publicKey),
        { principalId: identities.agent, publicKey },
      );
    }
    // This installation chooses the capabilities the suite drives before any
    // of it runs: the consent screen and the Access section belong to them,
    // and a device that has not chosen one has no such route (ADR 0130).
    await chooseCapabilities(context, 1280, capabilities);
    return { page, context, credentials, identities };
  };
}

/**
 * Bundle the fixture and both SDKs and launch the browser. `captures` is where
 * a suite's review screenshots go.
 */
export async function createLocalIamRig({
  harness,
  origin,
  rp,
  issuerUrl,
  captures,
}) {
  const fixture = await bundle(
    fileURLToPath(new URL("../fixtures/local-iam.ts", import.meta.url)),
    "LocalIamFixture",
  );
  const sdk = await bundle(
    `${root}/packages/static-auth/src/local-browser.ts`,
    "LocalRpSdk",
  );
  const agentSdk = await bundle(
    `${root}/packages/static-auth/src/local-agent.ts`,
    "LocalAgentSdk",
  );
  const browser = await harness.launch();
  return {
    browser,
    authenticator,
    tabTo,
    seedJourney: seedJourneyWith({
      harness,
      browser,
      origin,
      rp,
      issuerUrl,
      fixture,
      sdk,
      agentSdk,
    }),
    openConsent: openConsentWith(harness),
    approveConsent: approveConsentWith(captures),
  };
}
