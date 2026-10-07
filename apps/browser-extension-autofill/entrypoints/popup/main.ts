import "@opensesame/app-core/browser/security/security.css";
import { popupOperation } from "@/lib/popup/operation";
import {
  type PanelController,
  type PanelElements,
  mountPanel,
} from "@/lib/popup/panel";
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";

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
let productionPanel:
  | Promise<Awaited<ReturnType<typeof mountPanel>> | undefined>
  | undefined;
let activePanel: PanelController | undefined;
const security = startSecurityPanel(
  byId("security", HTMLElement),
  browser.runtime,
  (allowed) => {
    const main = document.querySelector("main");
    if (main) main.hidden = !allowed;
    if (allowed) startProductionPanel();
    else {
      activePanel?.invalidate();
      elements.origin.textContent = "";
      elements.code.value = "";
      const legend = elements.refs.querySelector("legend");
      elements.refs.replaceChildren(...(legend ? [legend] : []));
      elements.site.hidden = true;
      elements.pair.hidden = true;
      elements.go.hidden = true;
    }
  },
);
// Every reply is decoded before the panel sees it (`wire.ts`).
function startProductionPanel() {
  const permit = security.permit();
  const current = () => security.permit() === permit;
  const initialize = async () => {
    const panel = await mountPanel(elements, () =>
      popupOperation(security, {
        sendMessage: (message) => browser.runtime.sendMessage(message),
        request: (origins) =>
          browser.permissions.request({ origins: [...origins] }),
      }),
    );
    if (!current()) panel.invalidate();
    else activePanel = panel;
    return panel;
  };
  const previous = productionPanel;
  productionPanel = previous
    ? previous.then(async (panel) => {
        if (!current()) return panel;
        if (!panel) return initialize();
        activePanel = panel;
        await panel.refresh();
        return panel;
      })
    : security.ready.then(() => (current() ? initialize() : undefined));
  void productionPanel.catch(() => {
    if (!current()) return;
    const main = document.querySelector("main");
    if (main) main.hidden = true;
    elements.mark.textContent = "Security settings could not be initialized.";
  });
}

void security.ready.catch(() => {
  const main = document.querySelector("main");
  if (main) main.hidden = true;
  elements.mark.textContent = "Security settings could not be initialized.";
});
