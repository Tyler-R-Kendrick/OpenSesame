// One browser session: the built extension loaded unpacked into a real
// Chromium (new headless supports extensions), a provider that refuses web
// pages, and a page served from loopback.
//
// What a headless browser cannot do, and what stands in for it: the popup asks
// the browser for a host on a person's click, and the browser's prompt cannot
// be pressed in headless mode. So the session loads a copy of the built
// manifest with the grants a person's "Allow" would have given added as
// `host_permissions`; `permissions.request` for a host already held resolves
// at once, and every decision after it is the shipped code. The build under
// `.output/` is never modified.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startProvider } from "./provider.mjs";

const PACKAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const BUILD = path.join(PACKAGE, ".output/chrome-mv3");

const browserChoice = () =>
  process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : existsSync("/opt/pw-browsers/chromium")
      ? { executablePath: "/opt/pw-browsers/chromium" }
      : { channel: "chromium" };

/** The page every walk uses: it speaks the bridge's wire, as the app's client does. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>bridge page</title><script>
const CHANNEL = "opensesame.connector-bridge";
let counter = 0;
window.ask = (body, wait = 1500) =>
  new Promise((resolve) => {
    const id = "req_" + (++counter) + "_abcdefgh";
    const done = (event) => {
      const data = event.data;
      if (event.source !== window || !data || data.direction !== "response" || data.id !== id) return;
      window.removeEventListener("message", done);
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", done);
      resolve(null);
    }, wait);
    window.addEventListener("message", done);
    window.postMessage({ channel: CHANNEL, version: 1, direction: "request", id, ...body }, location.origin);
  });
</script>`;

async function startPage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The unpacked extension, with the grants a person's Allow would give. */
function stage(workdir, standing) {
  const target = path.join(workdir, "extension");
  try {
    cpSync(BUILD, target, { recursive: true });
  } catch (cause) {
    throw new Error(
      `no build at ${BUILD}: run \`pnpm --filter @opensesame/browser-extension-bridge build\` (${cause.code})`,
    );
  }
  const file = path.join(target, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.host_permissions = standing;
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (pattern) => !standing.includes(pattern),
    );
  writeFileSync(file, JSON.stringify(manifest));
  return target;
}

/** @param {{ standing?: string[] }} [options] the host patterns the person has allowed */
export async function startSession({
  standing = ["http://127.0.0.1/*", "https://api.plivo.com/*"],
} = {}) {
  const workdir = mkdtempSync(path.join(tmpdir(), "opensesame-bridge-e2e-"));
  const provider = await startProvider();
  const page = await startPage();
  const extension = stage(workdir, standing);
  const profile = path.join(workdir, "profile");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...browserChoice(),
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `--host-resolver-rules=MAP api.plivo.com 127.0.0.1:${provider.port}`,
        // The provider's certificate is made for this run, and only this browser trusts it.
        "--ignore-certificate-errors",
        "--no-proxy-server",
        "--remote-debugging-port=0",
      ],
    });
  } catch (cause) {
    await Promise.all([provider.close(), page.close()]);
    throw cause;
  }
  const worker = async () => {
    const [known] = context.serviceWorkers();
    return known ?? context.waitForEvent("serviceworker");
  };
  const id = new URL((await worker()).url()).host;
  return {
    context,
    profile,
    provider,
    page,
    id,
    worker,
    popupUrl: `chrome-extension://${id}/popup.html`,
    cleanups: [],
    async close() {
      for (const cleanup of this.cleanups) cleanup();
      await context.close().catch(() => undefined);
      await Promise.all([provider.close(), page.close()]);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
