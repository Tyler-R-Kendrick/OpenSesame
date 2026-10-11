/**
 * Settings › Trusted contacts (ADR 0187): the category's page. Three panels,
 * one for each side of a circle — the owner's, a guardian's and a
 * recipient's — over the desk, which is the one thing they share
 * (`use-desk.ts`). Each draws nothing while the vault is locked, a guest or a
 * decoy: a circle holds an owner key and a guardian a wrapped share, and
 * neither belongs in a session that is thrown away (ADR 0158).
 */

import { CirclesPanel } from "./CirclesPanel.js";
import { GuardingPanel } from "./GuardingPanel.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import "./trusted-contacts.css";

export function TrustedContacts() {
  return (
    <>
      <CirclesPanel />
      <GuardingPanel />
      <RecoveryPanel />
    </>
  );
}
