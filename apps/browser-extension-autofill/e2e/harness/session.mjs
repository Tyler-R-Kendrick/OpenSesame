// One browser session for a suite: the built extension loaded unpacked into a
// real Chromium (new headless supports extensions), the stub daemon on the
// extension's own daemon port, and the login pages on a loopback listener.
//
// What a headless browser cannot do, and what stands in for it
// ------------------------------------------------------------
// The extension asks the browser for a site on a person's click
// (`permissions.request`), and the browser answers with a prompt that no
// automation can press in headless mode: the promise stays pending. So a
// session has two manifests. `standing: false` is the shipped manifest,
// byte for byte, and proves what the extension can see with no grant at all.
// `standing: true` is the same build with the two grants a person's "Allow"
// would have given (`*.test` for these pages, and the daemon's loopback host)
// added as `host_permissions` in a temporary copy; `permissions.request` for
// a host already held resolves at once, so the popup's own switch, the
// background's registration, the guard and every check after them run the
// shipped code. The build under `.output/` is never modified.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startDaemonStub } from "./daemon-stub.mjs";
import { startSites } from "./sites.mjs";

const PACKAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const BUILD = path.join(PACKAGE, ".output/chrome-mv3");

/**
 * Extensions need a full Chromium in its new headless mode, never the
 * headless shell Playwright launches by default: the container's pinned build
 * (`PLAYWRIGHT_CHROMIUM`, as every other browser gate here), else the
 * `chromium` channel Playwright installs.
 */
const browserChoice = () =>
  process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : existsSync("/opt/pw-browsers/chromium")
      ? { executablePath: "/opt/pw-browsers/chromium" }
      : { channel: "chromium" };

/** The grants a person's "Allow" gives: the test pages and the daemon's loopback. */
const STANDING = ["http://*.test/*", "http://127.0.0.1/*"];

/** The unpacked extension to load, in a temp dir that is removed with the session. */
function stage(workdir, standing) {
  const target = path.join(workdir, "extension");
  try {
    cpSync(BUILD, target, { recursive: true });
  } catch (cause) {
    throw new Error(
      `no build at ${BUILD}: run \`pnpm --filter @opensesame/browser-extension-autofill build\` (${cause.code})`,
    );
  }
  if (!standing) return target;
  const file = path.join(target, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.host_permissions = STANDING;
  manifest.optional_host_permissions =
    manifest.optional_host_permissions.filter(
      (pattern) => !STANDING.includes(pattern),
    );
  writeFileSync(file, JSON.stringify(manifest));
  return target;
}

/**
 * @param {{ standing?: boolean, entries?: (origin: (host: string) => string) => object[] }} [options]
 */
export async function startSession({ standing = true, entries } = {}) {
  const workdir = mkdtempSync(path.join(tmpdir(), "opensesame-autofill-e2e-"));
  const sites = await startSites();
  const secret = `pw-${crypto.randomUUID()}`;
  const login = "alice.example";
  const stored = entries?.(sites.origin) ?? [
    {
      name: "Dev/app",
      url: `${sites.origin("app.test")}/login`,
      login,
      secret,
    },
  ];
  const daemon = await startDaemonStub({ entries: stored });
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
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        // These synthetic origins are loopback fixtures, resolved by Chromium.
        // An upstream proxy cannot resolve them to the local test listener.
        "--no-proxy-server",
        "--remote-debugging-port=0",
      ],
    });
  } catch (cause) {
    await Promise.all([daemon.close(), sites.close()]);
    throw cause;
  }
  const consoles = [];
  context.on("console", (message) => consoles.push(message.text()));
  const worker = async () => {
    const [known] = context.serviceWorkers();
    return known ?? context.waitForEvent("serviceworker");
  };
  const id = new URL((await worker()).url()).host;
  return {
    context,
    /** The browser profile directory (holds `DevToolsActivePort`). */
    profile,
    daemon,
    sites,
    secret,
    login,
    id,
    /** Console text from every page in the context. */
    consoles,
    worker,
    popupUrl: `chrome-extension://${id}/popup.html`,
    /** Run in order when the session closes. */
    cleanups: [],
    async close() {
      for (const cleanup of this.cleanups) cleanup();
      await context.close().catch(() => undefined);
      await Promise.all([daemon.close(), sites.close()]);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
