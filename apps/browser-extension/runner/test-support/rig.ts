import type { JsonObject } from "@opensesame/os-domain";
/**
 * Everything a walk needs, assembled once: a browser holding a site, a sealed
 * vault with a credential and a recovery key, a fake Host, and the runner
 * built from the real loop over all of them.
 */
import { createRecoveryKey } from "../backup";
import { type Connection, createRunner } from "../loop";
import { RunnerSettings } from "../settings";
import { SealedKv } from "../store";
import { RunnerVault } from "../vault";
import { FakeHost } from "./fake-host";
import { Browser, JsdomPages } from "./jsdom-pages";
import { MemoryStore, useTestDeviceKey } from "./memory";
import { RP, Site } from "./site";

export const CURRENT = "correct horse battery staple";

export interface Rig {
  host: FakeHost;
  site: Site;
  browser: Browser;
  store: MemoryStore;
  kv: SealedKv;
  settings: RunnerSettings;
  vault: RunnerVault;
  runner: ReturnType<typeof createRunner>;
  privateKey: JsonWebKey;
  granted: Set<string>;
  revoked: string[];
  closedTabs: (number | null)[];
  pagesOpened: number;
}

let recovery: Awaited<ReturnType<typeof createRecoveryKey>> | null = null;

export interface RigOptions {
  /** Pin a recovery key (default true). */
  recovery?: boolean;
  /** Hold a credential for the origin (default true). */
  credential?: boolean;
  /** Arm the origin (default true). */
  armed?: boolean;
  /** Give the origin's browser grant (default true). */
  grant?: boolean;
  /** Hold a Host session (default true). */
  session?: boolean;
  loginProfile?: boolean;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  useTestDeviceKey();
  const host = new FakeHost();
  const site = new Site(CURRENT);
  const browser = new Browser(site);
  const store = new MemoryStore();
  const kv = new SealedKv(store);
  const settings = new RunnerSettings(kv);
  const vault = new RunnerVault(kv);
  recovery ??= await createRecoveryKey();
  if (options.recovery !== false)
    await vault.setRecipient(recovery.recipient.jwk);
  if (options.credential !== false) {
    const entry: Parameters<RunnerVault["putEntry"]>[0] = {
      origin: RP,
      username: site.username,
      password: CURRENT,
    };
    if (options.loginProfile !== false) {
      entry.login = {
        url: `${RP}/login`,
        usernameSelector: "#user",
        passwordSelector: "#pass",
        submitSelector: "#signin",
        signedInSelector: "#welcome",
        rejectedSelector: "#denied",
      };
    }
    await vault.putEntry(entry);
  }
  if (options.armed !== false) await settings.arm(RP);
  if (options.session !== false) await settings.setToken("host-session-token");
  const granted = new Set<string>(options.grant === false ? [] : [RP]);
  const revoked: string[] = [];
  const closedTabs: (number | null)[] = [];
  const opened = { pages: 0 };
  const connection: Connection = { host, backup: host };
  let clock = 0;
  const runner = createRunner({
    settings,
    vault,
    grants: {
      has: async (origin) => granted.has(origin),
      revoke: async (origin) => {
        granted.delete(origin);
        revoked.push(origin);
      },
      privateAllowed: async () => browser.privateAllowed,
    },
    pagesFor: async (run) => {
      opened.pages += 1;
      browser.main ??= new JsdomPages(browser, run.origin, true);
      await settings.markActive(run.id, { origin: run.origin, tabId: 7 });
      return browser.main;
    },
    closePage: async (tabId) => {
      closedTabs.push(tabId);
    },
    connect: async () =>
      (await settings.token()) === null ? null : connection,
    // Wall-clock idle under CI load aborted a live walk: Date.now jumped past
    // idleMs while the executor was still enqueueing the next step. Advance
    // `now` only with `sleep` so contention cannot end the tick early.
    // Keep idleMs small: each null poll is a real claim round-trip, and 400
    // of them exceeds vitest's 5s budget when turbo saturates the runner.
    now: () => clock,
    sleep: async (ms = 1) => {
      clock += Math.max(ms, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    pollMs: 1,
    idleMs: 80,
    loginWindowMs: 40,
    waitMs: 40,
  });
  return {
    host,
    site,
    browser,
    store,
    kv,
    settings,
    vault,
    runner,
    privateKey: recovery.privateJwk,
    granted,
    revoked,
    closedTabs,
    get pagesOpened() {
      return opened.pages;
    },
  };
}

/**
 * Enqueue one step the way the executor does, without waiting for the runner.
 * The dispatch waiter uses wall-clock `setTimeout`. Keep it above a contended
 * settle (fake `now` does not stop the event loop from stalling under turbo)
 * and below vitest's testTimeout so refuse-without-settle cases that resolve
 * null on this timer still finish.
 */
export function enqueue(
  r: Rig,
  runId: string,
  request: JsonObject,
  ms = 2_000,
) {
  return r.host.dispatch(runId, request, ms);
}
