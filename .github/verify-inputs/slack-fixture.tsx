import React from "react";
import { createRoot } from "react-dom/client";
import "./src/sections/connections.css";
import { ConnectorMark, connectorMarkLookup } from "./src/sections/connections/ConnectorMark.js";
import { connectorMark } from "./src/sections/connections/connector-marks.js";
connectorMarkLookup.find = connectorMark;
createRoot(document.getElementById("root")!).render(
  <main>
    {["light", "dark"].map((theme) => (
      <section key={theme} data-theme-proof={theme} style={{ color: theme === "light" ? "#111" : "#fff", background: theme === "light" ? "#fff" : "#111", padding: 8 }}>
        {[24, 36, 48].map((size) => <div data-size={size} key={size}><ConnectorMark providerId="slack" displayName="Slack" size={size} /></div>)}
      </section>
    ))}
  </main>,
);
