import "@opensesame/app-core/browser/security/security.css";
import { FILL_MESSAGE, PAIR_MESSAGE } from "@/lib/fill/protocol";
import {
  type PairRequest,
  type PopupRequest,
  pairReply,
  statusReply,
  triggerReply,
} from "@/lib/fill/wire";
import { type PanelElements, mountPanel } from "@/lib/popup/panel";
import { mountSecurityPanel } from "@opensesame/app-core/browser/security/panel.js";

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`popup is missing #${id}`);
  return found;
}

const elements: PanelElements = {
  origin: byId("origin", HTMLParagraphElement),
  site: byId("site", HTMLButtonElement),
  pair: byId("pair", HTMLButtonElement),
  code: byId("code", HTMLOutputElement),
  refs: byId("refs", HTMLFieldSetElement),
  go: byId("go", HTMLButtonElement),
  mark: byId("mark", HTMLSpanElement),
};

/** Ask the background; an unreachable one answers nothing, decoded as such. */
const security = await mountSecurityPanel(
  byId("security", HTMLElement),
  browser.runtime,
  (allowed) => {
    const main = document.querySelector("main");
    if (main) main.hidden = !allowed;
  },
);
const ask = (message: PopupRequest | PairRequest) =>
  browser.runtime
    .sendMessage({ ...message, securityPermit: security.permit() })
    .catch(() => null);

// Every reply is decoded before the panel sees it (`wire.ts`).
void mountPanel(elements, {
  status: async () =>
    statusReply.parse(await ask({ type: FILL_MESSAGE, op: "status" })),
  trigger: async (reference) =>
    triggerReply.parse(
      await ask({
        type: FILL_MESSAGE,
        op: "trigger",
        reference,
      }),
    ),
  enable: async (origin) =>
    statusReply.parse(
      await ask({
        type: FILL_MESSAGE,
        op: "enable",
        origin,
      }),
    ),
  disable: async () =>
    statusReply.parse(await ask({ type: FILL_MESSAGE, op: "disable" })),
  pair: async () => pairReply.parse(await ask({ type: PAIR_MESSAGE })),
  request: (origins) => browser.permissions.request({ origins: [...origins] }),
});
