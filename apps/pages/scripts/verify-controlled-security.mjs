/** Browser-issued synthetic validator → independent CLI; sealed optional receiver. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLLED_ORIGIN,
  CONTROLLED_PORT,
  defaultReceiverRefusal,
  deploymentProof,
} from "./lib/controlled-security-deployment.mjs";
import { controlledSecurityJourney } from "./lib/controlled-security-journey.mjs";
import {
  independentReceiver,
  privateFixture,
} from "./lib/controlled-security-processes.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { retiredOfflineHarness } from "./lib/retired-offline-harness.mjs";
import "./lib/expect-timeout.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const localDist = fileURLToPath(
  new URL("../dist-profiles/controlled-security/dist", import.meta.url),
);
const deployments = [
  {
    dist,
    port: 0,
    journey: defaultReceiverRefusal,
    proof: deploymentProof(
      dist,
      "shared_origin_demo",
      "https://tyler-r-kendrick.github.io",
    ),
  },
  {
    dist: localDist,
    port: CONTROLLED_PORT,
    journey: controlledSecurityJourney,
    proof: deploymentProof(
      localDist,
      "loopback_development",
      CONTROLLED_ORIGIN,
    ),
  },
];
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out =
  process.env.CONTROLLED_SECURITY_EVIDENCE_OUT ??
  path.join("/tmp", "opensesame-controlled-security");
fs.mkdirSync(out, { recursive: true });
const results = [];
let gate = "failed";
let currentFixture;
async function runFixture(deployment, width) {
  const directory = await privateFixture();
  currentFixture = directory;
  let receiver;
  let harness;
  let browser;
  let context;
  let cleanupFailed = false;
  let observed;
  try {
    receiver = await independentReceiver(directory);
    harness = await retiredOfflineHarness({
      dist: deployment.dist,
      port: deployment.port,
      base,
      passthrough: [receiver.origin],
    });
    browser = await harness.launch();
    const opened = await harness.newPage(browser, {
      device:
        width === 390
          ? phoneContext({ width, height: 844 })
          : { viewport: { width, height: 800 } },
    });
    context = opened.context;
    console.log(
      `START ${deployment.proof.profile} controlled security ${width}px`,
    );
    const result = await deployment.journey({
      ...opened,
      base,
      width,
      directory,
      receiver,
      out,
    });
    const errors = harness.log.filter((entry) => entry.kind === "PAGE-ERROR");
    if (errors.length)
      throw new Error("Controlled security produced uncaught page errors.");
    observed = { ...result, deployment: deployment.proof, pageErrors: [] };
    console.log(
      `PASS ${deployment.proof.profile} controlled security ${width}px`,
    );
  } finally {
    const cleanup = await Promise.allSettled([
      context?.close(),
      browser?.close(),
      harness?.close(),
      receiver?.close(),
    ]);
    cleanupFailed = cleanup.some((result) => result.status === "rejected");
  }
  if (cleanupFailed) throw new Error("Controlled fixture cleanup failed.");
  return observed;
}

try {
  for (const deployment of deployments) {
    for (const width of [390, 1280])
      results.push(await runFixture(deployment, width));
  }
  gate = "passed";
} catch (error) {
  // Private fixtures preserve diagnostic bytes; no passwords, IDs or pairing
  // material are printed from caught errors or downloaded configurations.
  console.error(
    "Controlled security browser gate failed. Preserve the private fixture and raw process diagnostics.",
  );
  if (currentFixture)
    fs.writeFileSync(
      path.join(currentFixture, "browser-error.private.txt"),
      String(error?.stack ?? error),
      { mode: 0o600 },
    );
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(out, "results.json"),
    `${JSON.stringify(
      {
        gate,
        deployments: deployments.map(({ proof }) => proof),
        results,
      },
      null,
      2,
    )}\n`,
  );
}
