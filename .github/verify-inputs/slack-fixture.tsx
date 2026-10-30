import React from "react";
import { createRoot } from "react-dom/client";
import "./src/sections/connections.css";
import { ConnectorMark, connectorMarkLookup } from "./src/sections/connections/ConnectorMark.js";
import { connectorMark } from "./src/sections/connections/connector-marks.js";
connectorMarkLookup.find = connectorMark;
const brands = [["slack", "Slack"], ["openai", "OpenAI"], ["sendgrid", "SendGrid"]];
createRoot(document.getElementById("root")!).render(
  <main>
    {["light", "dark"].map((theme) => (
      <section key={theme} data-theme-proof={theme} style={{ color: theme === "light" ? "#111" : "#fff", background: theme === "light" ? "#fff" : "#111", padding: 8 }}>
        {brands.map(([id, name]) => [24, 36, 48].map((size) => <div data-brand={id} data-size={size} key={`${id}-${size}`}><ConnectorMark providerId={id} displayName={name} size={size} /></div>))}
      </section>
    ))}
  </main>,
);
