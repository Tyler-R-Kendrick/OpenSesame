import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.js";
import { kvHydrate } from "./lib/kv.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const basenames = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

void (async () => {
  await kvHydrate([
    "settings.v1",
    "outbox.v1",
    "unlockHash.v1",
    "vaultItems.v1",
  ]);
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basenames === "/" ? undefined : basenames}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
  registerSW({ immediate: true });
})();
