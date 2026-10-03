/**
 * The runner's ports over the browser: the tab a run is driven in, the page
 * functions injected into it, and the per-origin grants that let it.
 *
 * Least privilege, spelled out:
 *
 * - The manifest's standing permissions are unchanged. `scripting` and every
 *   host but this machine's loopback are *optional*: the person's own click on
 *   the options page asks the browser for exactly one origin, and the grant is
 *   given back when the run ends or the arm expires (`loop.ts`).
 * - No content script is declared. Page functions are injected on demand with
 *   `scripting.executeScript` into the top frame of the run's own tab, in the
 *   extension's isolated world, and only while the tab is on the run's origin.
 * - A tab that has left the origin is not driven: the injection is refused
 *   before it is attempted, and the browser would refuse it anyway for want of
 *   a grant.
 */
import { matchPattern } from "./origin";
import { pfFill, pfLayout, pfPresence, pfReadDom, pfWaitFor } from "./page-fns";
import type { Grants, Landed, PagesFactory, StepPages } from "./ports";
import type { RunnerSettings } from "./settings";
import { type Tab, injectorFor, loaded, press, stillOf } from "./tab";

const LOAD_MS = 30_000;
const SCRIPTING = "scripting" as const;

export function browserGrants(): Grants {
  return {
    async has(origin) {
      return browser.permissions.contains({
        permissions: [SCRIPTING],
        origins: [matchPattern(origin)],
      });
    },
    async revoke(origin) {
      try {
        await browser.permissions.remove({ origins: [matchPattern(origin)] });
        const rest = await browser.permissions.getAll();
        const optional = (rest.origins ?? []).filter(
          (pattern) => !/^https?:\/\/(127\.0\.0\.1|localhost)\//.test(pattern),
        );
        if (optional.length === 0) {
          await browser.permissions.remove({ permissions: [SCRIPTING] });
        }
      } catch {
        // A manifest-declared host (this machine's loopback) is not removable.
      }
    },
    async privateAllowed() {
      return browser.extension.isAllowedIncognitoAccess();
    },
  };
}

function pagesForTab(tab: Tab, origin: string): StepPages {
  const { tabId } = tab;
  const injector = injectorFor(tabId, origin);
  const { inject, onOrigin } = injector;
  return {
    async navigate(url) {
      const done = await loaded(tabId, LOAD_MS, async () => {
        await browser.tabs.update(tabId, { url });
      });
      if (!(await onOrigin())) return "navigation";
      return done ? "ok" : "timeout";
    },
    async waitFor(selector, timeoutMs = 15_000): Promise<Landed> {
      return inject(pfWaitFor, [selector, timeoutMs], 2);
    },
    fill: (selector, value) => inject(pfFill, [selector, value], 2),
    presence: (selector, expected) =>
      inject(pfPresence, [selector, expected], 2),
    submit: (selector) => press(tabId, injector, selector),
    readDom: (strip) => inject(pfReadDom, [strip], 1),
    layout: () => inject(pfLayout, [], 1),
    capture: (maskSelectors) => stillOf(tabId, injector, maskSelectors),
    async fresh() {
      if (!(await browser.extension.isAllowedIncognitoAccess())) return null;
      const window = await browser.windows.create({
        incognito: true,
        url: "about:blank",
        focused: false,
      });
      const privateTab = window.tabs?.[0]?.id;
      if (window.id === undefined || privateTab === undefined) return null;
      const windowId = window.id;
      return pagesForTab(
        {
          tabId: privateTab,
          dispose: () => browser.windows.remove(windowId),
        },
        origin,
      );
    },
    close: () => tab.dispose(),
  };
}

/**
 * The factory the loop opens a run's page with: the run's own tab, found again
 * after a worker restart, or a new background one on the run's origin.
 */
export function browserPages(settings: RunnerSettings): PagesFactory {
  return async (run) => {
    const held = (await settings.active()).get(run.id);
    let tabId: number | null = null;
    if (held?.tabId != null) {
      tabId = await browser.tabs
        .get(held.tabId)
        .then((tab) => tab.id ?? null)
        .catch(() => null);
    }
    if (tabId === null) {
      const created = await browser.tabs.create({
        url: "about:blank",
        active: false,
      });
      tabId = created.id ?? null;
      if (tabId === null) return null;
      await settings.markActive(run.id, { origin: run.origin, tabId });
    }
    const id = tabId;
    return pagesForTab(
      { tabId: id, dispose: () => browser.tabs.remove(id) },
      run.origin,
    );
  };
}

/** Close a run's tab once the run is over. A tab already gone is already closed. */
export async function closeRunTab(tabId: number | null): Promise<void> {
  if (tabId !== null) await browser.tabs.remove(tabId).catch(() => undefined);
}
