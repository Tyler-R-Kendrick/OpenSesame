/**
 * Test fixture: the whole legacy shell — the five optional sections with
 * their rail trees, the Connections settings category, the jumps, command
 * paths, item kinds and every optional tutorial partition — registered the
 * way the modules do on activation. Returns one revoke for all of it.
 */

import { registerLegacySections } from "../lib/contributions.test-support.js";
import { registerContributionForTest } from "../lib/contributions.js";
import { registerOptionalTutorials } from "../tutorial/registry/optional-tutorials.test-support.js";
import { AccessTree } from "./AccessTree.js";
import { ConnectionsTree } from "./ConnectionsTree.js";
import { IdentityTree } from "./IdentityTree.js";
import { WalletTree } from "./WalletTree.js";

function ConnectionsSettingsStub() {
  return <section aria-label="Connections settings" />;
}

export function registerLegacyShell(): () => void {
  const revokes = [
    // Targets before the rows that bind to them: `useGuideTarget` refuses an
    // id the live catalog does not declare, exactly as it would in the app.
    registerOptionalTutorials(),
    registerLegacySections(),
    registerContributionForTest("section", {
      id: "connections",
      to: "/connections",
      label: "Connections",
      segment: "connections",
      jump: "c",
      icon: "connection",
      order: 20,
      Tree: ConnectionsTree,
    }),
    registerContributionForTest("section", {
      id: "access",
      to: "/access",
      label: "Access",
      segment: "access",
      jump: "a",
      icon: "authority",
      order: 30,
      Tree: AccessTree,
    }),
    registerContributionForTest("section", {
      id: "identity",
      to: "/identity",
      label: "Identity",
      segment: "identity",
      jump: "i",
      icon: "user",
      order: 40,
      Tree: IdentityTree,
    }),
    registerContributionForTest("section", {
      id: "wallet",
      to: "/wallet",
      label: "Wallet",
      segment: "wallet",
      jump: "w",
      icon: "card",
      order: 50,
      Tree: WalletTree,
    }),
    registerContributionForTest("section", {
      id: "activity",
      to: "/activity",
      label: "Activity",
      segment: "activity",
      jump: "y",
      icon: "clock",
      order: 60,
    }),
    registerContributionForTest("settings-category", {
      id: "connections",
      label: "Connections",
      guideId: "settings.connections",
      Panel: ConnectionsSettingsStub,
      order: 40,
    }),
  ];
  return () => {
    for (const revoke of revokes) revoke();
  };
}
