/**
 * The slice of the WebExtension API the runner uses, over jsdom tabs.
 *
 * `scripting.executeScript` evaluates the function's source inside the tab's
 * page, as the browser does, so the adapter (`browser.ts`) is tested against
 * the real page functions rather than a stub of them.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import type { Site } from "./site";

type Listener = (id: number, info: { status?: string; url?: string }) => void;

interface FakeTab {
  id: number;
  windowId: number;
  incognito: boolean;
  url: string;
  dom: JSDOM;
  status: "loading" | "complete";
}

export class FakeBrowser {
  readonly tabs = new Map<number, FakeTab>();
  readonly listeners = new Set<Listener>();
  readonly granted = {
    permissions: new Set<string>(),
    origins: new Set<string>(),
  };
  readonly manifestHosts = ["http://127.0.0.1/*", "http://localhost/*"];
  incognitoAllowed = true;
  private nextId = 1;
  captures: number[] = [];
  /** The qualities asked for, and the size of a still at each. */
  stillBytes = (_quality: number) => 1_000;
  /** Calls to executeScript, by function name. */
  readonly injected: string[] = [];
  /** Make the next injection fail, as a frame torn down by a navigation does. */
  failNextInjection: Error | null = null;
  /** What a click on a control does to the tab, if anything. */
  onClick: ((tab: FakeTab) => void) | null = null;

  constructor(readonly site: Site) {}

  private page(tab: FakeTab, url: string) {
    const parsed = new URL(url);
    tab.url = url;
    tab.dom = new JSDOM(
      this.site.render(parsed.pathname, false, parsed.search),
      {
        runScripts: "outside-only",
        url,
      },
    );
  }

  private fire(id: number, info: { status?: string; url?: string }) {
    for (const listener of [...this.listeners]) listener(id, info);
  }

  /** Move a tab to `url`, with the events a real navigation fires. */
  navigateTab(id: number, url: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("no tab");
    tab.status = "loading";
    this.fire(id, { status: "loading", url });
    this.page(tab, url);
    setTimeout(() => {
      tab.status = "complete";
      this.fire(id, { status: "complete" });
    }, 0);
  }

  private open(url: string, incognito: boolean, windowId: number): FakeTab {
    const tab: FakeTab = {
      id: this.nextId++,
      windowId,
      incognito,
      url,
      dom: new JSDOM("<html></html>", {
        url: url === "about:blank" ? "about:blank" : url,
      }),
      status: "complete",
    };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  private hasHost(url: string): boolean {
    const origin = new URL(url).origin;
    return (
      this.granted.origins.has(`${origin}/*`) ||
      this.manifestHosts.some(
        (p) => new URL(p.replace("/*", "/")).hostname === new URL(url).hostname,
      )
    );
  }

  private permissionsApi() {
    return {
      contains: async (want: {
        permissions?: string[];
        origins?: string[];
      }) =>
        (want.permissions ?? []).every((p) =>
          this.granted.permissions.has(p),
        ) &&
        (want.origins ?? []).every(
          (o) =>
            this.granted.origins.has(o) ||
            this.manifestHosts.includes(o) ||
            this.manifestHosts.some(
              (m) =>
                new URL(m.replace("/*", "/")).hostname ===
                new URL(o.replace("/*", "/")).hostname,
            ),
        ),
      request: async (want: {
        permissions?: string[];
        origins?: string[];
      }) => {
        for (const p of want.permissions ?? []) this.granted.permissions.add(p);
        for (const o of want.origins ?? []) this.granted.origins.add(o);
        return true;
      },
      remove: async (gone: {
        permissions?: string[];
        origins?: string[];
      }) => {
        for (const o of gone.origins ?? []) {
          if (this.manifestHosts.includes(o))
            throw new Error("required permission");
          this.granted.origins.delete(o);
        }
        for (const p of gone.permissions ?? [])
          this.granted.permissions.delete(p);
        return true;
      },
      getAll: async () => ({
        permissions: [...this.granted.permissions],
        origins: [...this.manifestHosts, ...this.granted.origins],
      }),
    };
  }

  private tabsApi() {
    return {
      onUpdated: {
        addListener: (l: Listener) => this.listeners.add(l),
        removeListener: (l: Listener) => this.listeners.delete(l),
      },
      get: async (id: number) => {
        const tab = this.tabs.get(id);
        if (!tab) throw new Error("No tab with id");
        return {
          id,
          windowId: tab.windowId,
          status: tab.status,
          url: this.hasHost(tab.url) ? tab.url : undefined,
        };
      },
      create: async (props: { url?: string }) => ({
        id: this.open(props.url ?? "about:blank", false, 1).id,
      }),
      update: async (id: number, props: { url?: string; active?: boolean }) => {
        if (props.url) this.navigateTab(id, props.url);
        return { id };
      },
      remove: async (id: number) => {
        if (!this.tabs.delete(id)) throw new Error("No tab with id");
      },
      captureVisibleTab: async (
        _windowId: number,
        options: { quality: number },
      ) => {
        this.captures.push(options.quality);
        const text = "A".repeat(this.stillBytes(options.quality));
        return `data:image/jpeg;base64,${btoa(text)}`;
      },
    };
  }

  private windowsApi() {
    return {
      create: async (props: { incognito: boolean; url: string }) => {
        const windowId = 100 + this.nextId;
        const tab = this.open(props.url, props.incognito, windowId);
        return { id: windowId, tabs: [{ id: tab.id }] };
      },
      remove: async (windowId: number) => {
        for (const [id, tab] of this.tabs)
          if (tab.windowId === windowId) this.tabs.delete(id);
      },
    };
  }

  private scriptingApi() {
    return {
      executeScript: async (injection: {
        target: { tabId: number; frameIds: number[] };
        world: string;
        func: (...a: never[]) => BoundaryValue | Promise<BoundaryValue>;
        args: BoundaryValue[];
      }) => {
        this.injected.push(injection.func.name);
        expect_(injection.world === "ISOLATED", "isolated world");
        expect_(
          injection.target.frameIds.length === 1 &&
            injection.target.frameIds[0] === 0,
          "top frame only",
        );
        if (this.failNextInjection) {
          const error = this.failNextInjection;
          this.failNextInjection = null;
          throw error;
        }
        const tab = this.tabs.get(injection.target.tabId);
        if (!tab) throw new Error("No tab");
        if (!this.hasHost(tab.url))
          throw new Error("Cannot access contents of the page");
        // SAFETY: the evaluated source is the page function's own text, so its type matches that signature.
        const body = tab.dom.window.eval(`(${injection.func.toString()})`) as (
          ...a: BoundaryValue[]
        ) => BoundaryValue | Promise<BoundaryValue>;
        const wasClick = injection.func.name === "pfSubmit";
        const result = await body(...injection.args);
        if (wasClick) this.onClick?.(tab);
        return [{ result }];
      },
    };
  }

  api() {
    return {
      runtime: {
        id: "ext-id",
        getURL: (p: string) => `chrome-extension://ext-id/${p}`,
      },
      extension: {
        isAllowedIncognitoAccess: async () => this.incognitoAllowed,
      },
      permissions: this.permissionsApi(),
      tabs: this.tabsApi(),
      windows: this.windowsApi(),
      scripting: this.scriptingApi(),
    };
  }

  install() {
    vi.stubGlobal("browser", this.api());
  }
}

function expect_(ok: boolean, what: string) {
  if (!ok) throw new Error(`injection must be ${what}`);
}
