import { StrictMode } from "react";
import { createRoot } from "./react-dom.js";
import { RpApp } from "./RpApp.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <RpApp
      name="RP Alpha"
      clientId="rp-alpha"
      sector="https://alpha.example.test"
      port={5174}
    />
  </StrictMode>,
);
