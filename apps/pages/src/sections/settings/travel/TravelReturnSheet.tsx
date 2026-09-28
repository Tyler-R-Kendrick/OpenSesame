/**
 * Turning travel mode off (ADR 0143 §6), as a ceremony in a sheet: choose
 * the bundle and type its return code, see what would come home, then put
 * it back. A bundle is hostile input; nothing is written until the last key.
 */

import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import { TravelNoticeMark } from "./TravelNoticeMark.js";
import { TravelRow } from "./TravelViews.js";
import { anyComesHome, previewFacts, sitesComing } from "./return-text.js";
import type { useTravelFlow } from "./useTravelFlow.js";

type Flow = ReturnType<typeof useTravelFlow>;

const FOOT =
  "Nothing is written to this device until you bring the vaults home. A vault already here is left alone.";

function BundleCard({ flow }: { flow: Flow }) {
  const { busy, bundle, code, notice } = flow;
  return (
    <form
      aria-label="Coming home"
      onSubmit={(event) => {
        event.preventDefault();
        flow.open();
      }}
    >
      <CeremonyShell
        ok={notice?.tone !== "err"}
        name="Open a travel bundle"
        primary={{
          label: "Open the bundle",
          submit: true,
          busy,
          disabled: !bundle || code.trim().length === 0,
          onClick: flow.open,
        }}
      >
        <ul className="travel__list">
          <TravelRow
            name={bundle?.name ?? "No bundle chosen"}
            meta="travel bundle"
            side={
              <label
                className="icon-btn icon-btn--sm travel__file"
                title="Choose the travel bundle"
              >
                <IconUpload size={16} />
                <span className="visually-hidden">
                  Choose the travel bundle
                </span>
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="Choose the travel bundle"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) flow.chooseBundle(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            }
          />
        </ul>
        <FieldShell
          id="travel-return-code"
          label="Return code"
          mono
          autoComplete="off"
          placeholder="ABCD-EFGH-…"
          value={code}
          readOnly={busy}
          onValueChange={flow.typeCode}
        />
        <TravelNoticeMark notice={notice} />
      </CeremonyShell>
    </form>
  );
}

function PreviewCard({
  flow,
  opened,
}: {
  flow: Flow;
  opened: Extract<Flow["mode"], { kind: "preview" }>["opened"];
}) {
  const { busy, grants, notice } = flow;
  const sites = sitesComing(opened.preview);
  return (
    <CeremonyShell
      ok={notice?.tone !== "err"}
      top="Bundle opened"
      name="Ready to come home"
      facts={previewFacts(opened.preview)}
      primary={{
        label: "Bring them home",
        busy,
        disabled: !anyComesHome(opened.preview),
        onClick: () => flow.bringHome(opened),
      }}
      secondary={{ label: "Not now", onClick: () => flow.reset() }}
    >
      {sites.length > 0 ? (
        <label className="travel__ack">
          <input
            type="checkbox"
            checked={grants}
            disabled={busy}
            onChange={(event) => flow.setGrants(event.target.checked)}
          />
          <span>{`Let these sites in again: ${sites.join(", ")}`}</span>
        </label>
      ) : null}
      <TravelNoticeMark notice={notice} />
    </CeremonyShell>
  );
}

export function TravelReturnSheet({
  flow,
  onClose,
}: {
  flow: Flow;
  onClose: () => void;
}) {
  const { mode } = flow;
  return (
    <CeremonySheet
      title="Turn off travel mode"
      mark={<IconDownload size={20} />}
      foot={FOOT}
      onClose={onClose}
    >
      {mode.kind === "preview" ? (
        <PreviewCard flow={flow} opened={mode.opened} />
      ) : (
        <BundleCard flow={flow} />
      )}
    </CeremonySheet>
  );
}
