import {
  POPUP_MESSAGE,
  type PopupAction,
  type PopupReply,
  type PopupStatus,
} from "@/lib/popup-api";
/**
 * The popup (ADR 0199). It reads the status from the background and draws it;
 * every change is the person's own click. Asking the browser for a permission
 * has to happen here, in the gesture, so the popup makes the request and the
 * background reads the browser's answer back.
 */
import { renderPanel } from "@/lib/popup/panel";
import { webOrigin } from "@/lib/sites";

async function ask(action: PopupAction): Promise<PopupReply> {
  return browser.runtime.sendMessage({ type: POPUP_MESSAGE, ...action });
}

async function activeOrigin(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url ? webOrigin(tab.url) : null;
}

async function status(origin: string | null): Promise<PopupStatus> {
  const reply = await ask({ action: "status", origin });
  if (!("status" in reply)) throw new Error("The bridge did not answer");
  return reply.status;
}

async function draw(root: HTMLElement) {
  const origin = await activeOrigin();
  const current = await status(origin);
  renderPanel(root, current, {
    toggleSite: () => {
      if (!origin) return;
      const run = current.enabled
        ? ask({ action: "disable", origin })
        : browser.permissions
            .request({ origins: [`${origin}/*`] })
            .then(() => ask({ action: "enable", origin }));
      void run.then(() => draw(root));
    },
    allow: (host) => {
      void browser.permissions
        .request({ origins: [`https://${host}/*`] })
        .then(() => ask({ action: "granted" }))
        .then(() => draw(root));
    },
    revoke: (host) => {
      void ask({ action: "revoke", host }).then(() => draw(root));
    },
  });
}

const root = document.getElementById("panel");
if (root) void draw(root);
