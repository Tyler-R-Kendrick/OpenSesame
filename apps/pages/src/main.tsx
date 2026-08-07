import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const basenames = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={basenames === "/" ? undefined : basenames}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

registerSW({ immediate: true });
