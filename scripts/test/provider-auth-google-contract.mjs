/** Header-less Google callback/SDK contract proof; never a live Google account grant. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const receiverFixture = `
import {createNativeImplicitReceiver} from "./packages/app-core/src/browser/native-implicit-session.ts";
window.beginContract = async (mode) => {
  const lifetime = new AbortController();
  const redirectUri = location.origin + "/auth/native-google.html";
  const receiver = await createNativeImplicitReceiver({providerId:"google",redirectUri,nonce:"n".repeat(32)});
  window.contractJournal = [];
  window.contractOrder = [];
  window.contractResult = receiver.wait({expiresAt:Date.now()+60000,signal:lifetime.signal,
    assertCurrent:()=>{if(lifetime.signal.aborted)throw new Error("Stale lease");},
    retain:async(payload)=>{
      window.contractJournal.push(payload);
      window.contractOrder.push("retained");
      if(mode==="stale")lifetime.abort();
    }
  }).then(value=>({received:true}),error=>({received:false,error:error.message}));
  return {state:receiver.state,redirectUri,expiresAt:Date.now()+60000};
};`;
const sdkFixture = `
window.gisLaunches=[];
window.google={accounts:{oauth2:{
 initTokenClient(options){return {requestAccessToken(request){
  window.gisLaunches.push(request);
  options.callback({access_token:"sdk-contract-issued-token",token_type:"Bearer",expires_in:3600,scope:"openid"});
 }};},
 revoke(token,callback){callback({successful:true});}
}}};`;

async function callbackBuild(root, directory) {
  const require = createRequire(
    path.join(root, "packages/app-core/package.json"),
  );
  const { build } = require("esbuild");
  await fs.mkdir(path.join(directory, "auth"), { recursive: true });
  await build({
    entryPoints: [path.join(root, "apps/pages/auth/native-google-consent.ts")],
    outfile: path.join(directory, "auth/native-google-consent.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { __NATIVE_GOOGLE_HEADER_SECURITY__: "false" },
    alias: {
      "@opensesame/app-core": path.join(root, "packages/app-core/src"),
      "@opensesame/os-domain": path.join(
        root,
        "packages/os-domain/src/browser.ts",
      ),
    },
  });
  const html = await fs.readFile(
    path.join(root, "apps/pages/auth/native-google.html"),
    "utf8",
  );
  await fs.writeFile(
    path.join(directory, "auth/native-google.html"),
    html.replace("native-google-consent.ts", "native-google-consent.js"),
  );
  await build({
    stdin: { contents: receiverFixture, resolveDir: root, loader: "ts" },
    outfile: path.join(directory, "receiver.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  await fs.writeFile(
    path.join(directory, "receiver.html"),
    '<script type="module" src="/receiver.js"></script>',
  );
}
async function serve(directory) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file =
      pathname === "/receiver.html" ? "receiver.html" : pathname.slice(1);
    if (
      !/^(receiver\.(js|html)|auth\/native-google\.(html)|auth\/native-google-consent\.js)$/.test(
        file,
      )
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await fs.readFile(path.join(directory, file));
    response.setHeader(
      "Content-Type",
      file.endsWith("js") ? "text/javascript" : "text/html",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    // A separate approved header-less deployment. The strict product origin is unchanged.
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address?.port > 0);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function corsProvider(origin) {
  const observations = { preflights: 0, verified: 0 };
  const server = http.createServer((request, response) => {
    if (request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      observations.preflights += 1;
      response.setHeader("Access-Control-Allow-Headers", "authorization");
      response.setHeader("Access-Control-Allow-Methods", "GET");
      response.writeHead(204).end();
      return;
    }
    if (request.headers.authorization !== "Bearer sdk-contract-issued-token") {
      response.writeHead(401).end();
      return;
    }
    observations.verified += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "verified-provider-cors-fixture" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address?.port > 0);
  return {
    url: `http://127.0.0.1:${address.port}/userinfo`,
    observations,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function scenario(context, origin, mode, providerUrl) {
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "application/javascript", body: sdkFixture }),
  );
  const initiator = await context.newPage();
  await initiator.goto(`${origin}/receiver.html`);
  await initiator.waitForFunction(() => Boolean(window.beginContract));
  const request = await initiator.evaluate(
    (mode) => window.beginContract(mode),
    mode,
  );
  const consent = await context.newPage();
  await consent.goto(
    `${request.redirectUri}#${new URLSearchParams({
      clientId: "approved-contract-client",
      scopes: '["openid"]',
      state: request.state,
      expiresAt: String(request.expiresAt),
    })}`,
  );
  await consent.waitForFunction(
    () => !document.getElementById("authorize").disabled,
  );
  // Remove DevTools interception before resource fetch, so Chromium enforces real CORS.
  await context.unrouteAll({ behavior: "wait" });
  assert.equal(await consent.evaluate(() => location.hash), "");
  assert.deepEqual(await consent.evaluate(() => window.gisLaunches), []);
  await consent.locator(mode === "cancel" ? "#cancel" : "#authorize").click();
  const result = await initiator.evaluate(async () => ({
    result: await window.contractResult,
    journal: window.contractJournal,
    frames: window.contractFrames,
    order: window.contractOrder,
  }));
  assert(!JSON.stringify(result.frames).includes("sdk-contract-issued-token"));
  if (mode === "cancel") {
    assert.equal(result.result.received, false);
    assert.match(result.result.error, /declined/);
    assert.deepEqual(result.journal, []);
  } else {
    assert.equal(result.result.received, true);
    assert.equal(result.journal[0].accessToken, "sdk-contract-issued-token");
    assert.deepEqual(result.order, ["retained", "acknowledged"]);
  }
  if (mode === "success") {
    const verified = await initiator.evaluate(async (url) => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${window.contractJournal[0].accessToken}`,
        },
      });
      if (!response.ok)
        throw new Error("Provider fixture authorization failed");
      return response.json();
    }, providerUrl);
    assert.equal(verified.id, "verified-provider-cors-fixture");
  }
  await initiator.close();
  if (!consent.isClosed()) await consent.close();
}

export async function runProviderAuthGoogleContract({ root, out, browser }) {
  const directory = path.join(out, "google-headerless-contract");
  await callbackBuild(root, directory);
  const site = await serve(directory);
  const provider = await corsProvider(site.origin);
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      window.contractFrames = [];
      const original = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (value) {
        window.contractFrames.push(value);
        if (value?.kind === "accepted")
          window.contractOrder?.push("acknowledged");
        return original.call(this, value);
      };
    });
    for (const mode of ["success", "cancel", "stale"])
      await scenario(context, site.origin, mode, provider.url);
    assert.equal(provider.observations.preflights, 1);
    assert.equal(provider.observations.verified, 1);
    return {
      proof:
        "Google SDK contract intercepted in an approved header-less callback fixture; no live customer grant",
      freshSecondClick: true,
      publicFragmentScrubbed: true,
      encryptedReturnToInitiator: true,
      journalBeforeAcknowledgement: true,
      cancelWithoutMintedGrant: true,
      staleLeaseDuringRetentionKeepsIssuedCredentials: true,
      plaintextBearerOnChannel: false,
      providerCorsVerificationFixture: true,
    };
  } finally {
    await context.close();
    await provider.close();
    await site.close();
  }
}
