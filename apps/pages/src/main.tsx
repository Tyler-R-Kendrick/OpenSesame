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
  ]);
  vaultStore.rehydrate();

  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename === "/" ? undefined : basename}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
  registerSW({ immediate: true });
})();
