import { normalizeLoopbackBaseUrl } from "@opensesame/api-client";
import { overlapCast, isString } from "@opensesame/os-domain";

type HealthResponse = {
  health?: { ok?: boolean };
  daemon?: { available?: boolean };
  cursor?: { deviceId?: string; epoch?: number };
  hostBase?: string;
  error?: string;
};

const DEFAULT_HOST = "http://127.0.0.1:8787";

async function loadHostInput() {
  const input = overlapCast(document.getElementById("host"));
  if (!input) return;
  try {
    const stored = await chrome.storage.local.get("hostApiBase");
    input.value =
      isString(stored.hostApiBase) && stored.hostApiBase.trim()
        ? stored.hostApiBase
        : DEFAULT_HOST;
  } catch {
    input.value = DEFAULT_HOST;
  }
}

async function saveHost() {
  const input = overlapCast(document.getElementById("host"));
  const hint = document.getElementById("hint");
  if (!input) return;
  const raw = input.value.trim() || DEFAULT_HOST;
  const value = normalizeLoopbackBaseUrl(raw);
  if (!value) {
    if (hint) {
      hint.hidden = false;
      hint.textContent =
        "Host API must be a loopback URL (http://127.0.0.1:8787 or http://localhost:8787).";
    }
    return;
  }
  input.value = value;
  await chrome.storage.local.set({ hostApiBase: value });
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

async function loadStatus() {
  const list = document.getElementById("status");
  const hint = document.getElementById("hint");
  if (!list) return;
  setStatusItems(list, ["Checking…"]);
  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
  try {
    const res = overlapCast(await chrome.runtime.sendMessage({
      type: "opensesame.health",
    }));
    if (res?.error) {
      throw new Error(res.error);
    }
    const host = res.health?.ok ? "up" : "down";
    const daemon = res.daemon?.available
      ? "available"
      : "unavailable (optional)";
    const cursor = res.cursor
      ? `${res.cursor.deviceId ?? "?"} @ epoch ${res.cursor.epoch ?? 0}`
      : "n/a";
    const base = res.hostBase ?? DEFAULT_HOST;
    setStatusItems(list, [
      `Host API (${base}): ${host}`,
      `Daemon: ${daemon}`,
      `Sync cursor: ${cursor}`,
    ]);
    if (host === "down" && hint) {
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
  void loadStatus();
});
document.getElementById("save")?.addEventListener("click", () => {
  void saveHost();
});

void (async () => {
  await loadHostInput();
  await loadStatus();
})();
