/**
 * Turning travel mode on (ADR 0143 §1–§3), as a ceremony in a sheet: choose
 * what travels, pack the rest into a bundle under a return code, then take
 * it off this device once the bundle and the code are somewhere else.
 *
 * The return code is shown once, as text to write down — never put on the
 * clipboard, which keeps its own history.
 */

import { useDeviceVaults } from "../../../bindings/vaults.js";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import { TravelNoticeMark } from "./TravelNoticeMark.js";
import { TravelRow, plural, saveBundle } from "./TravelViews.js";
import type { useTravelFlow } from "./useTravelFlow.js";

type Flow = ReturnType<typeof useTravelFlow>;

const FOOT =
  "Nothing leaves this device until you confirm the bundle and the return code are somewhere else.";

function PlanCard({ flow }: { flow: Flow }) {
  const { safe, busy, notice } = flow;
  const vaults = useDeviceVaults().filter(
    (vault) => vault.kind !== "guest" && vault.state !== "empty",
  );
  const travels = (id: string, open: boolean) => open || safe.has(id);
  const staying = vaults.filter(
    (vault) => !travels(vault.id, vault.state === "open"),
  );
  return (
    <CeremonyShell
      ok={notice?.tone !== "err"}
      name="Choose what travels"
      facts={[
        {
          key: "Travels",
          value: plural(vaults.length - staying.length, "vault"),
        },
        { key: "Leaves", value: plural(staying.length, "vault") },
      ]}
      primary={{
        label: "Pack the rest for travel",
        busy,
        onClick: flow.pack,
      }}
    >
      <ul className="travel__list" aria-label="Safe for travel">
        {vaults.map((vault) => {
          const open = vault.state === "open";
          const on = travels(vault.id, open);
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
                  aria-label={label}
                  title={label}
                  disabled={busy || open}
                  onClick={() => flow.toggleSafe(vault.id)}
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
  pkg: Extract<Flow["mode"], { kind: "packed" }>["pkg"];
}) {
  const { ack, busy, notice } = flow;
  return (
    <CeremonyShell
      ok={notice?.tone !== "err" && notice?.tone !== "warn"}
      top="Packed"
      name="Ready to leave"
      facts={[
        {
          key: "Leaving",
          value: pkg.departing
            .map((vault) => `${vault.label} · ${plural(vault.files, "file")}`)
            .join(", "),
        },
      ]}
      primary={{
        label: "Take them off this device",
        busy,
        disabled: !ack.bundleSaved || !ack.codeRecorded,
        onClick: () => flow.depart(pkg),
      }}
      secondary={{ label: "Keep them here", onClick: () => flow.reset() }}
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
        <strong id="travel-code-label">Return code</strong>
        <p className="travel__code" aria-labelledby="travel-code-label">
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
      <TravelNoticeMark notice={notice} />
    </CeremonyShell>
  );
}

export function TravelLeaveSheet({
  flow,
  onClose,
}: {
  flow: Flow;
  onClose: () => void;
}) {
  const { mode } = flow;
  return (
    <CeremonySheet
      title="Turn on travel mode"
      mark={<IconUpload size={20} />}
      foot={FOOT}
      onClose={onClose}
    >
      {mode.kind === "packed" ? (
        <PackedCard flow={flow} pkg={mode.pkg} />
      ) : (
        <PlanCard flow={flow} />
      )}
    </CeremonySheet>
  );
}
