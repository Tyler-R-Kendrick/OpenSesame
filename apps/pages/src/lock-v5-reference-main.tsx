import "./host/boot.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LockV5UnlockReference } from "./dev/LockV5UnlockReference.js";
import "./components/wordmark.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <LockV5UnlockReference />
  </StrictMode>,
);
