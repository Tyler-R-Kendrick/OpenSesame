/**
 * Leaving items home (ADR 0171), as a ceremony in a sheet: choose which of
 * this vault's items stay home, pack them into a bundle under a return code,
 * then take them out once the bundle and the code are somewhere else.
 *
 * The open vault is the one being changed, so its item titles are drawn
 * here, in the owner's Settings, and nowhere after: nothing remembers the
 * choice, and the return code is shown once as text, never put on the
 * clipboard.
 */

import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { TravelNoticeMark } from "./TravelNoticeMark.js";
import { TravelRow, plural, saveBundle } from "./TravelViews.js";
import { hideableItems, itemKindLabel } from "./items-text.js";
import type { useTravelFlow } from "./useTravelFlow.js";

type Flow = ReturnType<typeof useTravelFlow>;

function ChooseCard({ flow }: { flow: Flow }) {
  const { chosen, busy, notice } = flow;
  const items = hideableItems(useVault().items);
  return (
    <CeremonyShell
      ok={notice?.tone !== "err"}
      name="Choose what stays home"
      facts={[
        { key: "Stays home", value: plural(chosen.size, "item") },
        {
          key: "Stays here",
          value: plural(items.length - chosen.size, "item"),
        },
      ]}
      primary={{
        label: "Pack the items for travel",
        icon: <IconDownload size={18} />,
        busy,
        disabled: chosen.size === 0,
        onClick: flow.packItems,
      }}
    >
      <ul className="travel__list" aria-label="Stays home">
        {items.map((item) => {
          const label = `Stays home: ${item.name.trim() || "Untitled"}`;
          return (
            <TravelRow
              key={item.id}
              name={item.name.trim() || "Untitled"}
              meta={itemKindLabel(item)}
              side={
                <button
                  type="button"
                  className="toggle"
                  role="switch"
                  aria-checked={chosen.has(item.id)}
                  aria-label={label}
                  title={label}
                  disabled={busy}
                  onClick={() => flow.toggleItem(item.id)}
                />
              }
            />
          );
        })}
      </ul>
      <TravelNoticeMark notice={notice} />
    </CeremonyShell>
  );
}

function PackedCard({
  flow,
  pkg,
}: {
  flow: Flow;
  pkg: Extract<Flow["mode"], { kind: "items_packed" }>["pkg"];
}) {
  const { ack, busy, copiesKnown, notice } = flow;
  return (
    <CeremonyShell
      ok={notice?.tone !== "err" && notice?.tone !== "warn"}
      top="Packed"
      name="Ready to leave"
      facts={[
        {
          key: "Leaving",
          value: pkg.items.map((item) => item.label).join(", "),
        },
      ]}
      primary={{
        label: "Take them out of this vault",
        busy,
        disabled: !ack.bundleSaved || !ack.codeRecorded || !copiesKnown,
        onClick: () => flow.hideItems(pkg),
      }}
    >
      <ul className="travel__list" aria-label="The travel bundle">
        <TravelRow
          name={pkg.bundleFileName}
          meta="travel bundle"
          side={
            <IconKey
              small
              label="Save the travel bundle"
              onClick={() => saveBundle(pkg)}
            >
              <IconDownload size={16} />
            </IconKey>
          }
        />
      </ul>
      <div>
        <strong id="travel-items-code-label">Return code</strong>
        <p className="travel__code" aria-labelledby="travel-items-code-label">
          {pkg.returnCode}
        </p>
      </div>
      <label className="travel__ack">
        <input
          type="checkbox"
          checked={ack.bundleSaved}
          onChange={(event) =>
            flow.setAck({ ...ack, bundleSaved: event.target.checked })
          }
        />
        <span>The bundle is saved somewhere other than this device</span>
      </label>
      <label className="travel__ack">
        <input
          type="checkbox"
          checked={ack.codeRecorded}
          onChange={(event) =>
            flow.setAck({ ...ack, codeRecorded: event.target.checked })
          }
        />
        <span>The return code is written down, and it stays home</span>
      </label>
      <label className="travel__ack">
        <input
          type="checkbox"
          checked={copiesKnown}
          onChange={(event) => flow.setCopiesKnown(event.target.checked)}
        />
        <span>
          Other devices, exports and backups still hold these items; losing the
          bundle and the code loses them here
        </span>
      </label>
      <TravelNoticeMark notice={notice} />
    </CeremonyShell>
  );
}

export function TravelItemsSheet({
  flow,
  onClose,
}: {
  flow: Flow;
  onClose: () => void;
}) {
  const { mode } = flow;
  return (
    <CeremonySheet
      title="Leave items at home"
      mark={<IconUpload size={20} />}
      onClose={onClose}
    >
      {mode.kind === "items_packed" ? (
        <PackedCard flow={flow} pkg={mode.pkg} />
      ) : (
        <ChooseCard flow={flow} />
      )}
    </CeremonySheet>
  );
}
