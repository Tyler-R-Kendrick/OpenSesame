import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { VaultShell } from "./components/VaultShell.js";
import { isOnline, subscribeConnectivity } from "./lib/connectivity.js";
import { isUnlocked } from "./lib/lock.js";
import { AgentPage } from "./pages/AgentPage.js";
import { AuthorizePage } from "./pages/AuthorizePage.js";
import { ClaimPage } from "./pages/ClaimPage.js";
import { ConnectionsPage } from "./pages/ConnectionsPage.js";
import { ProtocolPage } from "./pages/ProtocolPage.js";
import { QueuePage } from "./pages/QueuePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { UnlockPage } from "./pages/UnlockPage.js";
import { VaultPage } from "./pages/VaultPage.js";

function LockedLayout({ online }: { online: boolean }) {
  const location = useLocation();
  if (!isUnlocked()) {
    return (
      <Navigate to="/unlock" replace state={{ from: location.pathname }} />
    );
  }
  return (
    <VaultShell online={online}>
      <Outlet />
    </VaultShell>
  );
}

export function App() {
  const [online, setOnline] = useState(isOnline());

  useEffect(() => subscribeConnectivity(setOnline), []);

  return (
    <Routes>
      <Route path="/unlock" element={<UnlockPage />} />
      <Route element={<LockedLayout online={online} />}>
        <Route path="/" element={<Navigate to="/vault" replace />} />
        <Route path="/vault" element={<VaultPage />} />
        <Route path="/vault/:itemId" element={<VaultPage />} />
        <Route path="/agent" element={<AgentPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/authorize" element={<AuthorizePage online={online} />} />
        <Route path="/claim" element={<ClaimPage online={online} />} />
        <Route path="/task" element={<TaskPage online={online} />} />
        <Route path="/protocol" element={<ProtocolPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/queue" element={<QueuePage online={online} />} />
        <Route path="*" element={<Navigate to="/vault" replace />} />
      </Route>
    </Routes>
  );
}
