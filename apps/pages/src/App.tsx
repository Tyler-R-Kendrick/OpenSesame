import { Route, Routes } from "react-router";
import { useEffect, useState } from "react";
import { DepthBand } from "./components/DepthBand.js";
import { isOnline, subscribeConnectivity } from "./lib/connectivity.js";
import { SurfacePage } from "./pages/SurfacePage.js";
import { VaultPage } from "./pages/VaultPage.js";
import { AuthorizePage } from "./pages/AuthorizePage.js";
import { ClaimPage } from "./pages/ClaimPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { ProtocolPage } from "./pages/ProtocolPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { QueuePage } from "./pages/QueuePage.js";

export function App() {
  const [online, setOnline] = useState(isOnline());

  useEffect(() => subscribeConnectivity(setOnline), []);

  return (
    <div className="shell">
      <div className="brand-row">
        <h1 className="brand">OpenSesame</h1>
        <span
          className={`chip ${online ? "online" : "offline"}`}
          role="status"
          aria-live="polite"
        >
          {online ? "online" : "offline"}
        </span>
      </div>
      <DepthBand />
      <Routes>
        <Route path="/" element={<SurfacePage online={online} />} />
        <Route path="/vault" element={<VaultPage />} />
        <Route path="/authorize" element={<AuthorizePage online={online} />} />
        <Route path="/claim" element={<ClaimPage online={online} />} />
        <Route path="/task" element={<TaskPage online={online} />} />
        <Route path="/protocol" element={<ProtocolPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/queue" element={<QueuePage online={online} />} />
      </Routes>
    </div>
  );
}
