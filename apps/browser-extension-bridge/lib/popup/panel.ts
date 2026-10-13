/**
 * The popup's view (ADR 0199), a pure function of the status the background
 * reports: this tab's origin and whether the bridge is on for it, the hosts a
 * page has asked for and the person has not answered, and the hosts allowed.
 * Every action is an icon key with a label; none runs on load.
 */
import type { HostRow, PopupStatus } from "../popup-api.js";

export type PanelActions = {
  toggleSite: () => void;
  allow: (host: string) => void;
  revoke: (host: string) => void;
};

const CHECK = "M5 12.5l4.5 4.5L19 7.5";
const CROSS = "M6 6l12 12M18 6L6 18";
const POWER = "M12 3v8 M7 6.5a7 7 0 1 0 10 0";

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
  mark.setAttribute("d", path);
  mark.setAttribute("fill", "none");
  mark.setAttribute("stroke", "currentColor");
  mark.setAttribute("stroke-width", "2");
  mark.setAttribute("stroke-linecap", "round");
  mark.setAttribute("stroke-linejoin", "round");
  svg.append(mark);
  return svg;
}

function key(label: string, path: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(path));
  button.addEventListener("click", run);
  return button;
}

function hostRow(row: HostRow, action: HTMLButtonElement): HTMLLIElement {
  const item = document.createElement("li");
  const text = document.createElement("div");
  const host = document.createElement("p");
  host.className = "host";
  host.textContent = row.host;
  const providers = document.createElement("p");
  providers.className = "providers";
  providers.textContent = row.providers.join(", ");
  text.append(host, providers);
  item.append(text, action);
  return item;
}

function section(
  title: string,
  rows: HTMLLIElement[],
  empty: string,
): HTMLElement {
  const block = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  block.append(heading);
  if (rows.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = empty;
    block.append(none);
    return block;
  }
  const list = document.createElement("ul");
  list.append(...rows);
  block.append(list);
  return block;
}

export function renderPanel(
  root: HTMLElement,
  status: PopupStatus,
  actions: PanelActions,
): void {
  const children: HTMLElement[] = [];
  const site = document.createElement("div");
  site.className = "site";
  const origin = document.createElement("p");
  origin.className = "origin";
  origin.textContent = status.origin ?? "Open the OpenSesame app in this tab";
  site.append(origin);
  if (status.origin) {
    const toggle = key(
      status.enabled
        ? "Turn the bridge off for this site"
        : "Turn the bridge on for this site",
      POWER,
      actions.toggleSite,
    );
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(status.enabled));
    site.append(toggle);
  }
  children.push(site);
  children.push(
    section(
      "Waiting for you",
      status.pending.map((row) =>
        hostRow(
          row,
          key(`Allow ${row.host}`, CHECK, () => actions.allow(row.host)),
        ),
      ),
      "Nothing is waiting.",
    ),
  );
  children.push(
    section(
      "Allowed",
      status.granted.map((row) =>
        hostRow(
          row,
          key(`Stop allowing ${row.host}`, CROSS, () =>
            actions.revoke(row.host),
          ),
        ),
      ),
      "No host is allowed yet.",
    ),
  );
  root.replaceChildren(...children);
}
