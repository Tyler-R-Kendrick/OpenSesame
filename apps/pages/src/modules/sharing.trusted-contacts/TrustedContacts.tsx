/**
 * Settings › Security › Trusted contacts (ADR 0187): the owner's circles over
 * the desk they share (`use-desk.ts`). It draws nothing while the vault is
 * locked, a guest or a decoy: a circle holds an owner key, and it does not
 * belong in a session that is thrown away (ADR 0158).
 */

import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { UnlockCirclePanel } from "./UnlockCirclePanel.js";
import { useDesk } from "./use-desk.js";
import "./trusted-contacts.css";

export function TrustedContacts() {
  const desk = useDesk();
  const target = useGuideTarget<HTMLElement>("settings.trusted-contacts");
  if (!desk) {
    return (
      <section
        ref={target}
        className="panel set__security"
        id="trusted-contacts"
        aria-labelledby="trusted-contacts-title"
      >
        <div className="panel__head">
          <div>
            <h2 id="trusted-contacts-title">Trusted contacts</h2>
          </div>
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
    <section
      ref={target}
      className="panel set__security"
      id="trusted-contacts"
      aria-labelledby="trusted-contacts-title"
    >
      <div className="panel__head">
        <div>
          <h2 id="trusted-contacts-title">Trusted contacts</h2>
        </div>
      </div>
      <div className="panel__body trusted-contacts__body">
        <UnlockCirclePanel />
      </div>
    </section>
  );
}
