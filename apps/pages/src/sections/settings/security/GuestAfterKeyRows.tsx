import { IconKey } from "../../../components/IconKey.js";
import { IconPlus, IconVault } from "../../../components/Icons.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { MethodRow } from "./MethodRow.js";

/**
 * Duress and Travel, drawn to a guest whose vault has no key yet.
 *
 * Both need a vault that is kept on this device, so they are the same two
 * sections the owner gets, with the same wording the authenticator row uses
 * for the same reason: Add sets the key first. Without them a person who came
 * in by the front door's Skip finds a Security page that never says these
 * exist, and the way to them (a key) is on the same page but not connected to
 * them (ADR 0158: the row that needs a setting opens the sheet that sets it).
 *
 * Never drawn in a duress decoy, which is a guest session too: someone made to
 * open Settings there finds nothing to disable and nothing that says it is
 * there (ADR 0155, INV-27). The caller draws these only for a guest that is
 * not a decoy and has no key.
 */
export function GuestAfterKeyRows({
  busy,
  onAddKey,
}: {
  busy: boolean;
  /** Opens the sheet that adds the vault's first key. */
  onAddKey: () => void;
}) {
  const add = (
    <IconKey label="Add" small disabled={busy} onClick={onAddKey}>
      <IconPlus size={16} />
    </IconKey>
  );
  return (
    <>
      <section className="panel set__security" id="duress-after-key">
        <div className="panel__head">
          <div>
            <h2>Duress</h2>
          </div>
        </div>
        <div className="panel__body">
          <MethodRow
            kind="duress"
            label="Duress code"
            state="Off"
            on={false}
            sub="After a key. Add sets the key first."
            action={add}
          />
        </div>
      </section>
      <section className="panel set__security" id="travel-after-key">
        <div className="panel__head">
          <div>
            <h2>Travel</h2>
          </div>
        </div>
        <div className="panel__body">
          <CeremonyRow
            icon={<IconVault size={16} />}
            label="Leave items at home"
            mark={null}
            sub="After a key. Add sets the key first."
            action={add}
          />
        </div>
      </section>
    </>
  );
}
