/**
 * Test fixture: the whole legacy shell — the five optional sections with
 * their rail trees, the Connections settings category, the jumps, command
 * paths, item kinds and every optional tutorial partition — registered the
 * way the modules do on activation. Returns one revoke for all of it.
 */

import {
  registerLegacySectionRows,
  registerLegacySections,
  registerLegacySettingsCategories,
} from "../lib/contributions.test-support.js";
import { AccessRailTree } from "../modules/access.authority/AccessRailTree.js";
import { IdentityRailTree } from "../modules/identity.local-iam/IdentityRailTree.js";
import { WalletTree } from "../modules/wallet.spending/WalletTree.js";
import { registerOptionalTutorials } from "../tutorial/registry/optional-tutorials.test-support.js";
import { ConnectionsTreeEntries } from "./ConnectionsTree.js";

function ConnectionsSettingsStub() {
  return <section aria-label="Connections settings" />;
}

export function registerLegacyShell(): () => void {
  const revokes = [
    // Targets before the rows that bind to them: `useGuideTarget` refuses an
    // id the live catalog does not declare, exactly as it would in the app.
    registerOptionalTutorials(),
    registerLegacySections(),
    registerLegacySectionRows({
      connections: ConnectionsTreeEntries,
      access: AccessRailTree,
      identity: IdentityRailTree,
      wallet: WalletTree,
    }),
    registerLegacySettingsCategories(ConnectionsSettingsStub),
  ];
  return () => {
    for (const revoke of revokes) revoke();
  };
}
