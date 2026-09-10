import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { build } from "vite";
import { localAccessJourney } from "./lib/local-access-journey.mjs";
import { localDevicesJourney } from "./lib/local-devices-journey.mjs";
import { localPolicyJourney } from "./lib/local-policy-journey.mjs";
import {
  assertConsumedApplicationRequest,
  localRequestJourney,
} from "./lib/local-request-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const rp = "https://rp.example.test";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const issuerUrl = `${origin}/OpenSesame/identity/authorize`;
const harness = createHarness({
  dist: fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base: "/OpenSesame/",
  out: "/tmp/local-iam",
});
const captures = fileURLToPath(
  new URL("../.impeccable/review", import.meta.url),
);
fs.mkdirSync(captures, { recursive: true });

async function bundle(entry, name) {
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
const fixture = await bundle(
  fileURLToPath(new URL("./fixtures/local-iam.ts", import.meta.url)),
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

async function authenticator(page, credentials = []) {
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
async function tabTo(page, target) {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard could not reach consent control");
}
function rpHtml(app, agent) {
  return `<!doctype html><html><body><button id="signin">Sign in locally</button><button id="check">Check session</button><button id="revoke">Revoke</button><output id="status">Signed out</output><script src="/client.js"></script><script src="/agent.js"></script><script>
const status = document.getElementById('status'); let session;
function refuse(message,error) {status.textContent=message;status.dataset.reason=['authorization_unavailable','invalid_response','invalid_identity','local_session_unavailable','local_session_closed','popup_closed','authorization_expired','local_request_timeout','agent_authentication_failed'].includes(error.message)?error.message:'other';}
document.getElementById('signin').onclick = () => { delete status.dataset.reason; status.textContent='Waiting'; const profile={authorizationEndpoint:${JSON.stringify(issuerUrl)},clientId:${JSON.stringify(app)},redirectUri:${JSON.stringify(`${rp}/callback`)},scopes:['openid','records:read']}; const agentId=${JSON.stringify(agent ?? null)}; if(agentId)profile.agent={principalId:agentId,keyId:localAgentKey.keyId,signChallenge:challenge=>{status.dataset.proof="requested";return localAgentKey.signChallenge(challenge,${JSON.stringify(origin)},agentId);}}; LocalRpSdk.signInLocalBrowser(profile).then(value=>{session=value;status.textContent='Signed in locally: '+value.identity.subject;},error=>refuse('Sign-in refused',error)); };
document.getElementById('check').onclick = () => {session.check('records:read').then(()=>{status.textContent='Session active';},error=>refuse('Session refused',error));};
document.getElementById('revoke').onclick = () => {session.revoke().then(()=>{status.textContent='Revoked';},error=>refuse('Revocation refused',error));};
</script></body></html>`;
}
async function openConsent(
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
  popup.on("pageerror", (error) => harness.record("PAGE-ERROR", error.message));
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
}

async function approveConsent(page, popup, width, agentMode = false) {
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
  await expect(allow).toBeVisible();
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
}

async function seedJourney(agentMode) {
  const { page: seedPage, context } = await harness.newPage(browser);
  // Keep the VM's observed wall-clock corrections out of the happy-path fixture.
  // Freeze wall time only; real timers and performance deadlines still advance.
  // assertClockRollbackRefusal moves wall time backwards explicitly.
  await context.clock.setFixedTime(new Date("2026-09-10T00:00:00Z"));
  await context.route(`${origin}/fixture`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Disposable IAM fixture</body></html>",
    }),
  );
  await seedPage.goto(`${origin}/fixture`);
  const device = await authenticator(seedPage);
  await seedPage.addScriptTag({ content: fixture });
  if (!(await seedPage.evaluate(() => Boolean(globalThis.LocalIamFixture))))
    throw new Error(
      `Fixture did not load: ${JSON.stringify(harness.log.filter((row) => row.kind === "PAGE-ERROR"))}`,
    );
  const identities = await seedPage.evaluate(() => LocalIamFixture.seed());
  const { credentials } = await device.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: device.authenticatorId,
  });
  const page = await context.newPage();
  await context.route(`${rp}/**`, (route) =>
    route.fulfill(
      route.request().url().endsWith("/client.js")
        ? { contentType: "text/javascript", body: sdk }
        : route.request().url().endsWith("/agent.js")
          ? { contentType: "text/javascript", body: agentSdk }
          : {
              contentType: "text/html",
              body: rpHtml(identities.app, agentMode ? identities.agent : null),
            },
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
  return { page, context, credentials, identities };
}

async function journey(width, agentMode = false) {
  const { page, context, credentials, identities } =
    await seedJourney(agentMode);
  const { popup, device: popupDevice } = await openConsent(
    page,
    context,
    credentials,
    width,
    agentMode,
  );
  await approveConsent(page, popup, width, agentMode);
  try {
    await expect(page.locator("output")).toHaveText(
      `Signed in locally: ${agentMode ? identities.agent : identities.person}`,
    );
  } catch (error) {
    console.error(
      "Sign-in failure stage:",
      await page.locator("output").getAttribute("data-reason"),
    );
    throw error;
  }
  await tabTo(page, page.getByRole("button", { name: "Check session" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Session active");
  const updated = await popupDevice.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: popupDevice.authenticatorId,
  });
  await tabTo(page, page.getByRole("button", { name: "Revoke", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Revoked");
  const denied = await openConsent(
    page,
    context,
    updated.credentials,
    width,
    agentMode,
  );
  await tabTo(
    denied.popup,
    denied.popup.getByRole("button", { name: "Deny", exact: true }),
  );
  const deniedWindow = denied.popup.waitForEvent("close");
  await denied.popup.keyboard.press("Enter").catch((error) => {
    if (!denied.popup.isClosed()) throw error;
  });
  await deniedWindow;
  await expect(page.locator("output")).toHaveText("Sign-in refused");
  await assertConsumedApplicationRequest(context, width);
  await assertClockRollbackRefusal(
    page,
    context,
    updated.credentials,
    width,
    agentMode,
  );
  await context.close();
  console.log(
    `PASS ${width}px ${agentMode ? "agent" : "person"}: cross-origin popup, encrypted vault unlock, passkey, consent, PKCE, session check, revocation and denial; fixed wall time, real timers, explicit rollback refusal`,
  );
}

async function assertClockRollbackRefusal(
  page,
  context,
  credentials,
  width,
  agentMode,
) {
  const { popup } = await openConsent(
    page,
    context,
    credentials,
    width,
    agentMode,
  );
  await approveConsent(page, popup, width, agentMode);
  await expect(page.locator("output")).toHaveText(/^Signed in locally: local_/);
  await context.clock.setFixedTime(new Date("2026-09-09T00:00:00Z"));
  await tabTo(page, page.getByRole("button", { name: "Check session" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Session refused");
  await expect(page.locator("output")).toHaveAttribute(
    "data-reason",
    "authorization_unavailable",
  );
}
try {
  for (const width of [1280, 390])
    await localRequestJourney({ width, seedJourney, authenticator, captures });
  for (const width of [1280, 390]) {
    await journey(width);
    await journey(width, true);
    for (const view of ["sessions", "grants"])
      await localAccessJourney({
        width,
        seedJourney,
        openConsent,
        approveConsent,
        captures,
        view,
      });
    await localPolicyJourney({
      width,
      seedJourney,
      openConsent,
      approveConsent,
      captures,
    });
    await localDevicesJourney({
      width,
      seedJourney,
      openConsent,
      approveConsent,
      authenticator,
      captures,
    });
  }
} catch (error) {
  for (const [index, context] of browser.contexts().entries()) {
    for (const [tab, page] of context.pages().entries()) {
      console.error(
        "Clock correction in ms:",
        await page
          .evaluate(() =>
            Math.round(Date.now() - performance.timeOrigin - performance.now()),
          )
          .catch(() => "page unavailable"),
      );
      if (new URL(page.url()).origin === rp)
        console.error(
          "RP failure stage:",
          await page.locator("output").getAttribute("data-reason"),
          await page.locator("output").getAttribute("data-proof"),
        );
      await page
        .screenshot({ path: `/tmp/local-iam-failure-${index}-${tab}.png` })
        .catch(() => console.warn("Failure screenshot unavailable"));
    }
  }
  throw error;
} finally {
  await browser.close();
}
if (
  harness.log.some(
    (row) => row.kind === "PAGE-ERROR" || row.kind === "LOOPBACK-REQUEST",
  )
)
  throw new Error("Unexpected browser error or backend request");
