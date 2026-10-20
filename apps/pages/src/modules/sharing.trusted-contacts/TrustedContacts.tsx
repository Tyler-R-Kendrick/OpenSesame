/**
 * Settings › Security › Trusted contacts (ADR 0187). Three panels,
 * one for each side of a circle — the owner's, a guardian's and a
 * recipient's — over the desk, which is the one thing they share
 * (`use-desk.ts`). Each draws nothing while the vault is locked, a guest or a
 * decoy: a circle holds an owner key and a guardian a wrapped share, and
 * neither belongs in a session that is thrown away (ADR 0158).
 */

import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { CirclesPanel } from "./CirclesPanel.js";
import { GuardingPanel } from "./GuardingPanel.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import { useDesk } from "./use-desk.js";
import "./trusted-contacts.css";

export function TrustedContacts() {
  const desk = useDesk();
  const target = useGuideTarget<HTMLElement>("settings.trusted-contacts");
  if (!desk) {
    return (
      <section
        ref={target}
        className="panel"
        id="trusted-contacts"
        aria-label="Trusted contacts"
      >
        <div className="panel__head">
          <h2>Trusted contacts</h2>
        </div>
        <div className="panel__body">
          <div className="actions">
            <StatusMark
              tone="idle"
              label="Trusted contacts need an unlocked owner vault. A guest or decoy session cannot keep a circle."
            />
          </div>
        </div>
      </section>
    );
  }
  return (
    <div id="trusted-contacts" ref={target}>
      <CirclesPanel />
      <GuardingPanel />
      <RecoveryPanel />
    </div>
  );
}
