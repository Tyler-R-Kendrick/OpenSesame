import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { kvHydrate } from "./lib/kv.js";
import {
  ATTEMPTS_KEY,
  BODY_KEY,
  HEADER_KEY,
  PREFS_KEY,
  vaultStore,
} from "./lib/vault/store.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

/// A vault must never render inside someone else's frame, where an overlay can
/// aim a click at a reveal or copy control. `frame-ancestors` is the real
/// defence but browsers ignore it from a <meta> tag, and a static host cannot
/// send the header, so refuse to run instead of unlocking inside the frame.
function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // Cross-origin parents throw on access, which itself answers the question.
    return true;
  }
}

if (framed()) {
  root.textContent =
    "OpenSesame will not run inside a frame. Open it in its own tab.";
  throw new Error("refusing to render inside a frame");
}

void (async () => {
  // OPFS is async and the store reads its header synchronously, so pull the
  // persisted keys into the KV cache and re-read before the first paint.
  await kvHydrate([
    HEADER_KEY,
    BODY_KEY,
    ATTEMPTS_KEY,
    PREFS_KEY,
    "settings.v1",
    "outbox.v1",
    "connections.firstRun.v1",
    "site-broker.consents.v1",
    "site-broker.policy.v1",
  ]);
  vaultStore.rehydrate();

  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename === "/" ? undefined : basename}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
  if (!crossOriginIsolated && "serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true },
    );
  }
  registerSW({ immediate: true });
})();
