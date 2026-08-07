type HealthResponse = {
  health?: { ok?: boolean };
  daemon?: { available?: boolean };
  cursor?: { deviceId?: string; epoch?: number };
  hostBase?: string;
  error?: string;
};

const DEFAULT_HOST = "http://127.0.0.1:8787";

async function loadHostInput() {
  const input = document.getElementById("host") as HTMLInputElement | null;
  if (!input) return;
  try {
    const stored = await chrome.storage.local.get("hostApiBase");
    input.value =
      typeof stored.hostApiBase === "string" && stored.hostApiBase.trim()
        ? stored.hostApiBase
        : DEFAULT_HOST;
  } catch {
    input.value = DEFAULT_HOST;
  }
}

async function saveHost() {
  const input = document.getElementById("host") as HTMLInputElement | null;
  const hint = document.getElementById("hint");
  if (!input) return;
  const value = input.value.trim().replace(/\/$/, "") || DEFAULT_HOST;
  input.value = value;
  await chrome.storage.local.set({ hostApiBase: value });
  if (hint) {
    hint.hidden = false;
    hint.textContent = "Host API saved.";
  }
  await loadStatus();
}

async function loadStatus() {
  const list = document.getElementById("status");
  const hint = document.getElementById("hint");
  if (!list) return;
  list.innerHTML = "<li>Checking…</li>";
  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "opensesame.health",
    })) as HealthResponse;
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
    list.innerHTML = `
      <li>Host API (${base}): ${host}</li>
      <li>Daemon: ${daemon}</li>
      <li>Sync cursor: ${cursor}</li>
    `;
    if (host === "down" && hint) {
      hint.hidden = false;
      hint.textContent = `Start the Host API on ${base}, then retry.`;
    }
  } catch (e) {
    list.innerHTML = `<li>Could not load status</li>`;
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
