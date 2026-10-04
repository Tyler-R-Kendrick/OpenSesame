/**
 * Status chrome for the Support sheet: the model download.
 *
 * Nothing here narrates the panel. A sentence that explains what the sheet is,
 * why nothing can answer, or what the browser's model context holds is
 * explainer copy, and `pnpm lint:design` rejects it (`docs/design/controls.md`).
 * What is left is the one thing a person can act on or watch: downloading the
 * on-device model. A running tutorial is drawn by tutorial mode itself
 * (`coach/CoachHud.tsx`), never inside this sheet.
 */

import type { SupportAgentAvailability } from "@opensesame/support-agent";
import type { ReactElement } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconDownload } from "../../components/Icons.js";

/**
 * The one gesture that changes what can answer, and the progress of it.
 *
 * Every other availability state renders nothing: "this browser has no model"
 * is a fact about the device, not something to do here, and the written help
 * below already answers the question it would have been explaining.
 */
export function Availability({
  availability,
  onAcquire,
}: {
  availability: SupportAgentAvailability | null;
  onAcquire: () => void;
}): ReactElement | null {
  if (availability?.kind === "downloading") {
    const percent = Math.round(availability.progress * 100);
    return (
      <div className="support__download">
        <output className="support__download-read">
          Downloading the on-device model — {percent}%
        </output>
        {/* The output beside it already reads the whole sentence; an unnamed
            progressbar would only announce "progress bar, 40". */}
        <progress
          className="support__progress"
          max={100}
          value={percent}
          aria-hidden="true"
        />
      </div>
    );
  }
  if (availability?.kind === "downloadable") {
    return (
      <div className="support__download">
        <FormCommit
          label="Download the on-device model"
          icon={<IconDownload size={18} />}
          onClick={onAcquire}
        />
      </div>
    );
  }
  return null;
}
