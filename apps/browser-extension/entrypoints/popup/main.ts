import "@opensesame/app-core/browser/security/security.css";
import { normalizeLoopbackBaseUrl } from "@opensesame/api-client";
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";
import { openFromRest, sealForRest } from "@opensesame/browser-at-rest";
import {
  type BoundaryObject,
  ENDPOINTS,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  createWorkflowHandoff,
  requireWorkflowOwner,
} from "../../runner/password-workflow-handoff";

type HealthResponse = {
  health?: { ok?: boolean };
  daemon?: { available?: boolean };
  cursor?: { deviceId?: string; epoch?: number };
  hostBase?: string;
  error?: string;
};

const DEFAULT_HOST = ENDPOINTS.host.default;
const securityRoot = document.getElementById("security");
const production = document.getElementById("production-controls");
if (!securityRoot || !production)
  throw new Error("Missing popup security controls.");
let real = false;
const security = startSecurityPanel(
  securityRoot,
  browser.runtime,
  (allowed) => {
    real = allowed && security.permit() !== undefined;
    production.hidden = !real;
    if (real) void loadOwnerControls();
  },
);
const handoff = createWorkflowHandoff(
  security,
  () => real,
  async (options) => {
    await browser.tabs.create(options);
  },
);
function failure() {
  const hint = document.getElementById("hint");
  if (hint) {
    hint.hidden = false;
    hint.textContent = "Unlock the real vault to continue.";
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "button[data-workflow]",
)) {
  button.addEventListener("click", () => {
    void handoff(button.dataset.workflow ?? "").catch(failure);
  });
}
async function loadOwnerControls() {
  try {
    await security.requireProduction();
    await loadHostInput();
    await loadStatus();
  } catch {
    failure();
  }
}
void security.ready.catch(() => {
  real = false;
  production.hidden = true;
});
/** Where `hostApiBase` rests, sealed (ADR 0149). */
const STORE = "chrome.storage.local";

async function loadHostInput() {
  const check = await requireWorkflowOwner(security, () => real);
  const input: HTMLInputElement | null = overlapCast(
    document.getElementById("host"),
  );
  if (!input) return;
  try {
    const stored =
      await browser.storage.local.get<BoundaryObject>("hostApiBase");
    check();
    // Sealed at rest (ADR 0149); a value from an older build reads as it is.
    const value = isString(stored.hostApiBase)
      ? await openFromRest(STORE, "hostApiBase", stored.hostApiBase)
      : null;
    check();
    input.value = value?.trim() ? value : DEFAULT_HOST;
  } catch {
    check();
    input.value = DEFAULT_HOST;
  }
}

async function saveHost() {
  const check = await requireWorkflowOwner(security, () => real);
  const input: HTMLInputElement | null = overlapCast(
    document.getElementById("host"),
  );
  const hint = document.getElementById("hint");
  if (!input) return;
  const raw = input.value.trim() || DEFAULT_HOST;
  const value = normalizeLoopbackBaseUrl(raw);
  if (!value) {
    if (hint) {
      hint.hidden = false;
      hint.textContent = `Host API must be a loopback URL (${DEFAULT_HOST}).`;
    }
    return;
  }
  input.value = value;
  const sealed = await sealForRest(STORE, "hostApiBase", value);
  check();
  if (sealed === null) {
    // Nothing is stored in the clear: with no key to seal under, not at all.
    if (hint) {
      hint.hidden = false;
      hint.textContent = "This browser cannot keep the Host API setting.";
    }
    return;
  }
  check();
  await browser.storage.local.set({ hostApiBase: sealed });
  check();
  if (hint) {
    hint.hidden = false;
    hint.textContent = "Host API saved.";
  }
  await loadStatus();
}

function setStatusItems(list: HTMLElement, items: string[]) {
  list.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
}

function healthStatusItems(res: HealthResponse): string[] {
  const host = res.health?.ok ? "up" : "down";
  const daemon = res.daemon?.available ? "available" : "unavailable (optional)";
  const cursor = res.cursor
    ? `${res.cursor.deviceId ?? "?"} @ epoch ${res.cursor.epoch ?? 0}`
    : "n/a";
  const base = res.hostBase ?? DEFAULT_HOST;
  return [
    `Host API (${base}): ${host}`,
    `Daemon: ${daemon}`,
    `Sync cursor: ${cursor}`,
  ];
}

async function loadStatus() {
  const check = await requireWorkflowOwner(security, () => real);
  const list = document.getElementById("status");
  const hint = document.getElementById("hint");
  if (!list) return;
  setStatusItems(list, ["Checking…"]);
  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
  try {
    const res: HealthResponse = overlapCast(
      await browser.runtime.sendMessage({
        type: "opensesame.health",
        securityPermit: security.permit(),
      }),
    );
    check();
    if (res?.error) {
      throw new Error(res.error);
    }
    const base = res.hostBase ?? DEFAULT_HOST;
    setStatusItems(list, healthStatusItems(res));
    if (!res.health?.ok && hint) {
      hint.hidden = false;
      hint.textContent = `Start the Host API on ${base}, then retry.`;
    }
  } catch (e) {
    setStatusItems(list, ["Could not load status"]);
    if (hint) {
      hint.hidden = false;
      hint.textContent =
        e instanceof Error ? e.message : "Background worker unavailable.";
    }
  }
}

document.getElementById("retry")?.addEventListener("click", () => {
  void loadStatus().catch(failure);
});
document.getElementById("save")?.addEventListener("click", () => {
  void saveHost().catch(failure);
});

document.getElementById("security-open")?.addEventListener("click", () => {
  void requireWorkflowOwner(security, () => real)
    .then((check) => {
      check();
      return browser.runtime.openOptionsPage();
    })
    .catch(failure);
});
