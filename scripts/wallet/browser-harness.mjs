#!/usr/bin/env node
/**
 * wallet:test:browser — Vitest Wallet fixtures + Playwright QAB.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNumber } from "./lib/primitive-guards.mjs";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";
import { runLeaseProbe } from "./lib/lease-probe.mjs";
import { runWalB20NarrowWallet } from "./lib/wallet-b20.mjs";
import { enterAsGuest, openWallet } from "./lib/wallet-capability.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(root, "apps/pages/dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = join(root, "artifacts/wallet-browser-qab");

function run(cmd, args) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PLAYWRIGHT_CHROMIUM:
        process.env.PLAYWRIGHT_CHROMIUM ??
        (existsSync("/opt/pw-browsers/chromium")
          ? "/opt/pw-browsers/chromium"
          : existsSync(
                `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`,
              )
            ? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`
            : undefined),
    },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return {
    exitCode: isNumber(r.status) ? r.status : 1,
    durationMs: Date.now() - started,
    command: [cmd, ...args].join(" "),
  };
}

async function runPlaywrightQab() {
  if (!existsSync(join(DIST, "index.html"))) {
    return {
      ok: false,
      reason: `no build at ${DIST} — run VITE_BASE=/OpenSesame/ pages build first`,
      details: {},
    };
  }

  mkdirSync(OUT, { recursive: true });

  const harnessMod = await import(
    pathToFileURL(
      join(root, "apps/pages/scripts/lib/static-origin-harness.mjs"),
    ).href
  );
  const { createHarness } = harnessMod;
  const { check, failures, launch, newPage, snap, setStep, log } =
    createHarness({
      dist: DIST,
      origin: ORIGIN,
      base: BASE,
      out: OUT,
    });

  const browser = await launch();
  /** @type {string[]} */
  const loopbackHits = [];

  try {
    setStep("QAB-01-guest-wallet");
    const { page, context } = await newPage(browser);

    page.on("request", (req) => {
      const url = req.url();
      if (
        /https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?\b/i.test(
          url,
        )
      ) {
        loopbackHits.push(url);
      }
    });

    await enterAsGuest(page, `${ORIGIN}${BASE}`);
    await openWallet(page, check);
    await page.waitForTimeout(800);
    const walletText = await snap(page, "QAB-01-wallet");
    check(
      /Wallet|Budgets|Payment methods|Execution adapters|guest/i.test(
        walletText,
      ),
      "Wallet overview renders for guest under static base",
    );
    check(
      !/Something went wrong|Uncaught|No Identity API/i.test(walletText),
      "Wallet has no crash / Identity-API wall",
    );
    check(loopbackHits.length === 0, "no loopback requests during Wallet boot");

    setStep("WAL-B20-narrow-wallet");
    await runWalB20NarrowWallet(page, check);

    setStep("QAB-03-forged-origin");
    const beforeStorage = await page.evaluate(() => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      return {
        keys,
        body: document.body?.innerText ?? "",
      };
    });
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.example",
          data: {
            type: "opensesame.spending.grant",
            approved: true,
            amount: "999999",
            assurance: "webauthn",
          },
        }),
      );
    });
    await page.waitForTimeout(400);
    const afterForge = await page.evaluate(() => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.push(k);
      }
      return {
        keys,
        body: document.body?.innerText ?? "",
        hasGrant: keys.some((k) => /spend|wallet|lease|grant/i.test(k)),
      };
    });
    check(
      !/999999/.test(afterForge.body) || /999999/.test(beforeStorage.body),
      "forged MessageEvent amount does not appear in Wallet UI",
    );
    check(
      JSON.stringify(afterForge.keys) === JSON.stringify(beforeStorage.keys),
      "forged cross-origin message does not mutate localStorage keys",
    );
    await context.close();

    setStep("WAL-B03-B05-passes-demo");
    const { page: passesPage, context: passesCtx } = await newPage(browser);
    const b03Hits = [];
    passesPage.on("request", (req) => {
      const url = req.url();
      if (
        /https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?\b/i.test(
          url,
        )
      ) {
        b03Hits.push(url);
      }
    });

    // Unlock first — virtual WebAuthn must not sit in front of guest seal.
    await enterAsGuest(passesPage, `${ORIGIN}${BASE}`);

    // CDP virtual authenticator after unlock: presence alone must not mint spend authority.
    const cdp = await passesPage.context().newCDPSession(passesPage);
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
    void authenticatorId;

    await openWallet(passesPage, check);
    await passesPage.waitForTimeout(400);
    await passesPage.locator('a[href$="/wallet/passes"]').first().click();
    await passesPage
      .getByRole("heading", { name: "Spending passes", exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await passesPage.waitForTimeout(400);
    const passesText = await snap(passesPage, "WAL-B03-B05-passes");
    check(
      /No spending passes yet/i.test(passesText),
      "WAL-B03: an attached authenticator mints no spending pass by presence alone",
    );
    // The panel's demo control is gone (bcd8d7c3); the product's lease module
    // runs in this browser on the static origin instead (lib/lease-probe.mjs).
    const probe = await runLeaseProbe(passesCtx, ORIGIN, BASE);
    log.push({ kind: "lease-probe", detail: JSON.stringify(probe) });
    check(
      probe.replay === "assertion_replay",
      "WAL-B03: lease module refuses assertion replay of spent verifiedBytes",
    );
    check(
      probe.expired === "lease_window_invalid",
      "WAL-B05: lease module refuses an already-expired lease window",
    );
    check(
      probe.forged === "unverified_assurance" &&
        probe.stranger === "key_not_enrolled",
      "WAL-B03: forged WebAuthn/RP assurance label refused (wrong-RP not treated as authority)",
    );
    check(
      probe.issued === "issued" && probe.leases === 1,
      "WAL-B03/B05 probe issued exactly the one enrolled, in-window lease",
    );
    check(b03Hits.length === 0, "WAL-B03/B05 path made no loopback requests");
    await passesCtx.close();
  } finally {
    await browser.close();
  }

  return {
    ok: failures.length === 0,
    reason: failures.length === 0 ? null : failures.slice(0, 8).join("; "),
    details: {
      failures,
      loopbackHits,
      logTail: log.slice(-20).map((e) => `${e.kind}:${e.detail}`),
    },
  };
}

async function main() {
  const mainnet = assertNoMainnet(process.argv.slice(2));
  if (!mainnet.ok) {
    writeWalletEvidence(root, {
      invokedAs: "pnpm wallet:test:browser",
      mainnet: {
        ok: false,
        message: mainnet.message,
        denials: mainnet.denials,
      },
      results: [
        {
          suite: "browser",
          status: "failed",
          exitCode: 2,
          reason: mainnet.message,
          command: null,
          durationMs: null,
        },
      ],
      ok: false,
      notes: ["Mainnet hard-deny fired before browser harness."],
    });
    console.error(mainnet.message);
    process.exit(2);
  }

  /** @type {import('./lib/evidence.mjs').SuiteResult[]} */
  const results = [];
  let ok = true;

  const unit = run("pnpm", [
    "--filter=@opensesame/pages",
    "--filter=@opensesame/app-core",
    "exec",
    "vitest",
    "run",
    "src/sections/WalletSection.test.tsx",
    "src/lib/spending-ledger.test.ts",
    "src/lib/spending-consent.test.ts",
    "src/lib/spending-leases.test.ts",
    "src/lib/wallet-safe-label.test.ts",
    "src/lib/wallet-isolation-claims.test.ts",
    "src/lib/wallet-budget-labels.test.ts",
    "src/lib/wallet-origin-profile.test.ts",
    "src/lib/wallet-sw-payment.test.ts",
    "src/lib/wallet-activation.test.ts",
    "src/lib/wallet-agent-broker.test.ts",
  ]);
  results.push({
    suite: "browser-vitest",
    status: unit.exitCode === 0 ? "passed" : "failed",
    exitCode: unit.exitCode,
    reason: unit.exitCode === 0 ? null : "Wallet vitest fixtures failed",
    command: unit.command,
    durationMs: unit.durationMs,
  });
  if (unit.exitCode !== 0) ok = false;

  let qab;
  try {
    qab = await runPlaywrightQab();
  } catch (err) {
    qab = {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      details: {},
    };
  }
  results.push({
    suite: "browser-QAB-playwright",
    status: qab.ok ? "passed" : "failed",
    exitCode: qab.ok ? 0 : 1,
    reason: qab.reason,
    command: "Playwright static Wallet QAB-01/QAB-03 + WAL-B03/B05",
    durationMs: null,
    details: qab.details,
  });
  if (!qab.ok) ok = false;

  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:browser",
    mainnet: { ok: true, message: null, denials: [] },
    results,
    ok,
    notes: [
      ok
        ? "browser fixtures + static Wallet QAB-01/QAB-03 + WAL-B03/B05 passes demo passed"
        : "browser harness failed",
      `Evidence: ${EVIDENCE_REL}`,
    ],
  });

  if (ok) {
    const claimsPath = join(root, "docs/evidence/wallet/claims.json");
    try {
      const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
      claims.claims = claims.claims ?? {};
      claims.claims["WAL-B03"] = {
        status: "fixture_verified",
        reason:
          "Playwright on the static origin: with a CDP virtual authenticator attached, Wallet › Spending passes (approved through Settings › Capabilities) shows no pass; the product's lease module, run in the same browser, refuses a forged WebAuthn label (unverified_assurance), an unenrolled key (key_not_enrolled) and spent verifiedBytes replay (assertion_replay). Not phishing-resistant RP ceremony binding.",
        productionEnabled: false,
        evidenceRefs: [
          "pnpm wallet:test:browser",
          "scripts/wallet/lib/lease-probe.mjs",
          "src/lib/spending-leases.test.ts",
          EVIDENCE_REL,
        ],
      };
      claims.claims["WAL-B04"] = {
        status: "fixture_verified",
        reason:
          "Playwright QAB-03 lite: evil.example postMessage spend grant does not mutate Wallet authority UI under static origin",
        productionEnabled: false,
        evidenceRefs: ["pnpm wallet:test:browser", EVIDENCE_REL],
      };
      claims.claims["WAL-B05"] = {
        status: "fixture_verified",
        reason:
          "Playwright on the static origin: the product's lease module, run in the browser, refuses an expired lease window (lease_window_invalid); listActiveSpendingLeases withholds expired rows",
        productionEnabled: false,
        evidenceRefs: [
          "pnpm wallet:test:browser",
          "scripts/wallet/lib/lease-probe.mjs",
          "src/lib/spending-leases.test.ts",
          EVIDENCE_REL,
        ],
      };
      claims.claims["WAL-B19"] = {
        status: "fixture_verified",
        reason:
          "QAB-01: guest Wallet overview under production base path with no Identity API / loopback",
        productionEnabled: false,
        evidenceRefs: ["pnpm wallet:test:browser", EVIDENCE_REL],
      };
      writeFileSync(claimsPath, `${JSON.stringify(claims, null, 2)}\n`);
    } catch (err) {
      console.error("wallet:browser — could not update claims.json", err);
    }
  }

  if (!ok) {
    console.error(`wallet:test:browser — FAIL. See ${EVIDENCE_REL}`);
    process.exit(1);
  }
  console.error(`wallet:test:browser — PASS. See ${EVIDENCE_REL}`);
  process.exit(0);
}

await main();
