import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { armInstall, ensurePersistence } from "./lib/install.js";
import { kvHydrate } from "./lib/kv.js";
import {
  PROJECTS_KEY,
  activeProject,
  projectScopedKeys,
  rehydrateProjects,
} from "./lib/projects.js";
import { loadRuntimeConfig } from "./lib/runtime-config.js";
import { vaultStore } from "./lib/vault/store.js";
import {
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "./lib/vault/tomb-migration.js";
import { TOMBS_REGISTRY_KEY } from "./lib/vfs.js";
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

// Chromium fires `beforeinstallprompt` as soon as it decides this page is
// installable, which is routinely before the boot below has finished awaiting
// OPFS. Miss that event and there is no second chance until the next load, so
// the listener goes on before anything asynchronous.
armInstall();

void (async () => {
  // OPFS is async and the store reads its header synchronously, so pull the
  // persisted keys into the KV cache and re-read before the first paint.
  // The boot record and tomb registry hydrate first: which tomb is active
  // decides which vault header and consent keys exist. Deployment endpoints
  // load before settings are first read, so an unbaked static deploy still
  // knows its Identity API without a rebuild.
  await loadRuntimeConfig();
  await kvHydrate([
    PROJECTS_KEY,
    TOMBS_REGISTRY_KEY,
    "settings.v1",
    "setup.v1",
    "outbox.v1",
    "connections.firstRun.v1",
  ]);
  rehydrateProjects();
  const tomb = activeProject().id;
  await kvHydrate([...projectScopedKeys(), ...tombStorageKeys(tomb)]);
  // Move any legacy flat vault keys into the tomb before the store reads it.
  // Pre-unlock this is plaintext moves only (header params, sealed body
  // bytes); sealed config migrates on unlock.
  await migrateLegacyVaultStorage(tomb);
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
  // A launch of the already-installed app fires no `appinstalled` and may never
  // mount the install card at all — the reader has no cause to open Settings —
  // so this is the only thing covering them.
  //
  // After the first *paint*, never before: browsers that prompt for persistent
  // storage would otherwise raise a bare permission dialog over a blank page.
  // `render()` only schedules work, so waiting on it is not enough — a frame
  // followed by a task is the point at which something is actually on screen.
  requestAnimationFrame(() => {
    setTimeout(() => void ensurePersistence(), 0);
  });
})();
