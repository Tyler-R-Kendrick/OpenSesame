/**
 * Settings › Vaults › Travel (ADR 0140).
 *
 * Mark the vaults that are safe to carry; the rest leave this device in a
 * bundle sealed under a return code, and come back from both. The panel
 * looks the same whether vaults are away or not — there is nothing on the
 * device that knows.
 */

import { useDeviceVaults } from "../../../bindings/vaults.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import {
  PackedView,
  ReturnForm,
  ReturnPreviewView,
  TravelNotice,
  TravelRow,
  travelRefusalText,
} from "./TravelViews.js";
import { useTravelFlow } from "./useTravelFlow.js";
import "../travel.css";

function SafeList({
  safe,
  busy,
  onToggle,
}: {
  safe: ReadonlySet<string>;
  busy: boolean;
  onToggle: (id: string) => void;
}) {
  const vaults = useDeviceVaults().filter(
    (vault) => vault.kind !== "guest" && vault.state !== "empty",
  );
  return (
    <ul className="travel__list" aria-label="Safe for travel">
      {vaults.map((vault) => {
        const open = vault.state === "open";
        const on = open || safe.has(vault.id);
        const label = `Safe for travel: ${vault.label}`;
        return (
          <TravelRow
            key={vault.id}
            name={vault.label}
            meta={open ? "open · travels" : on ? "travels" : "stays home"}
            side={
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={on}
                aria-pressed={on}
                aria-label={label}
                title={label}
                disabled={busy || open}
                onClick={() => onToggle(vault.id)}
              />
            }
          />
        );
      })}
    </ul>
  );
}

export function TravelPanel() {
  const flow = useTravelFlow();
  const { owner, mode, busy, notice } = flow;
  return (
    <section className="panel" id="travel" aria-labelledby="travel-title">
      <div className="panel__head">
        <div>
          <h2 id="travel-title">Travel</h2>
        </div>
        {owner && mode.kind === "plan" ? (
          <div className="actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Bring vaults home"
              title="Bring vaults home"
              disabled={busy}
              onClick={flow.startReturn}
            >
              <IconDownload size={16} />
            </button>
          </div>
        ) : null}
      </div>
      <div className="panel__body travel">
        {notice ? <TravelNotice tone={notice.tone} text={notice.text} /> : null}
        {!owner ? (
          <TravelNotice
            tone="idle"
            text={travelRefusalText("owner_not_present")}
          />
        ) : mode.kind === "plan" ? (
          <form
            className="travel"
            aria-label="Pack for travel"
            onSubmit={(event) => {
              event.preventDefault();
              flow.pack();
            }}
          >
            <SafeList safe={flow.safe} busy={busy} onToggle={flow.toggleSafe} />
            <FormCommit
              label="Pack the rest for travel"
              icon={<IconUpload size={18} />}
              disabled={busy}
              busy={busy}
            />
          </form>
        ) : mode.kind === "packed" ? (
          <PackedView
            pkg={mode.pkg}
            ack={flow.ack}
            busy={busy}
            onAck={flow.setAck}
            onDepart={() => flow.depart(mode.pkg)}
            onCancel={() => flow.reset()}
          />
        ) : mode.kind === "return" ? (
          <ReturnForm
            fileName={flow.bundle?.name ?? null}
            code={flow.code}
            busy={busy}
            onFile={flow.chooseBundle}
            onCode={flow.typeCode}
            onOpen={flow.open}
            onCancel={() => flow.reset()}
          />
        ) : (
          <ReturnPreviewView
            preview={mode.opened.preview}
            busy={busy}
            onReturn={() => flow.bringHome(mode.opened)}
            onCancel={() => flow.reset()}
          />
        )}
      </div>
    </section>
  );
}
