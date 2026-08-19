import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

/// A ceremony page must never render inside someone else's frame, where an
/// overlay can aim a click at an approve control. `frame-ancestors` is the
/// real defence but browsers ignore it from a <meta> tag, and the dev server
/// sends no such header, so refuse to run instead of consenting inside the
/// frame. Embedding is a registered, per-processor opt-in (ADR 0045), never
/// this default surface.
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
    "OpenSesame ceremonies will not run inside a frame. Open the link in its own tab.";
  throw new Error("refusing to render inside a frame");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
