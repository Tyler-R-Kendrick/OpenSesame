import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell.js";
import { useSessionGuards, useTheme, useVault } from "./lib/vault/hooks.js";
import { UnlockScreen } from "./screens/UnlockScreen.js";
import { AgentsSection } from "./sections/AgentsSection.js";
import { AuthoritySection } from "./sections/AuthoritySection.js";
import { SettingsSection } from "./sections/SettingsSection.js";
import { SitesSection } from "./sections/SitesSection.js";
import { VaultSection, VaultWelcome } from "./sections/VaultSection.js";
import { HealthPanel } from "./sections/vault/HealthPanel.js";
import { ItemDetail } from "./sections/vault/ItemDetail.js";
import { ItemEditor } from "./sections/vault/ItemEditor.js";

/** Scrolling frame for every section except the vault, which owns its own panes. */
function Framed({ children }: { children: ReactNode }) {
  return <main className="section">{children}</main>;
}

export function App() {
  const { status } = useVault();
  useTheme();
  useSessionGuards();

  if (status !== "unlocked") {
    return <UnlockScreen />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/vault" replace />} />
        <Route path="/vault" element={<VaultSection />}>
          <Route index element={<VaultWelcome />} />
          <Route path="health" element={<HealthPanel />} />
          <Route path="new/:kind" element={<ItemEditor mode="new" />} />
          <Route path=":itemId/edit" element={<ItemEditor mode="edit" />} />
          <Route path=":itemId" element={<ItemDetail />} />
        </Route>
        <Route
          path="/agents"
          element={
            <Framed>
              <AgentsSection />
            </Framed>
          }
        />
        <Route
          path="/sites"
          element={
            <Framed>
              <SitesSection />
            </Framed>
          }
        />
        <Route
          path="/authority"
          element={
            <Framed>
              <AuthoritySection />
            </Framed>
          }
        />
        <Route
          path="/settings"
          element={
            <Framed>
              <SettingsSection />
            </Framed>
          }
        />
        <Route path="*" element={<Navigate to="/vault" replace />} />
      </Routes>
    </AppShell>
  );
}
