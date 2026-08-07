import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpApp } from "./RpApp.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <RpApp
      name="RP Beta"
      clientId="rp-beta"
      sector="https://beta.example.test"
      port={5175}
    />
  </StrictMode>,
);
