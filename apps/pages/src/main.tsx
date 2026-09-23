// Must stay first: installs the host the shared core reads (ADR 0133).
import "./host/boot.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { registerDuressUiModule } from "@opensesame/app-core/lib/duress/feature/mode.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { bootCore } from "./bootstrap/boot.js";
import { armInstall, ensurePersistence } from "./lib/install.js";
// The shell and the vault load behind the unlock gate (app-root.tsx), but
// their stylesheets stay in the first bundle, ahead of styles.css: a
// stylesheet that arrives with a lazy chunk lands after the shared rules and
// wins every cascade tie they used to win — the editor's type chip lost its
// 44px floor that way. Order here is the order the bundle always had.
import "./components/command-bar.css";
import "./components/connections-tree.css";
import "./components/slash-search.css";
import "./components/statusline.css";
import "./components/wordmark.css";
import "./sections/vault.css";
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

// The shared core never imports UI (ADR 0133); the shell says how to load the
// duress settings panel when the duress runtime warms its capabilities.
registerDuressUiModule(
  () => import("./components/duress/DuressSettingsPanel.js"),
);

/**
 * The worker registration controller (S08) picks the variant the plan
 * requires and registers it. Until it lands, boot proceeds without a worker
 * rather than registering one the plan did not ask for.
 */
async function registerWorker(): Promise<void> {
  try {
    const [controller, { DISTRIBUTION }] = await Promise.all([
      import("@opensesame/app-core/lib/capabilities/worker-controller.js"),
      import("./lib/capabilities/distribution.js"),
    ]);
    controller.registerWorkerForPlan(compositionStore, {
      distribution: DISTRIBUTION,
    });
  } catch {
    // No controller in this build: no worker is registered.
  }
}

void (async () => {
  await bootCore();
  if (import.meta.env.DEV) await import("./lib/agent-page-dump.js");

  // The shell arrives only after the plan is resolved: optional code is
  // imported by the loader under a lease, never by the entry.
  const { AppRoot } = await import("./app-root.js");
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename === "/" ? undefined : basename}>
        <AppRoot />
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
  void registerWorker();
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
