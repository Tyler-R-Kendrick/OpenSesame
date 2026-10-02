/**
 * Status chrome for the Support sheet: the model download and the live
 * walkthrough strip.
 *
 * Nothing here narrates the panel. A sentence that explains what the sheet is,
 * why nothing can answer, or what the browser's model context holds is
 * explainer copy, and `pnpm lint:design` rejects it (`docs/design/controls.md`).
 * What is left is the two things a person can act on or watch: downloading the
 * on-device model, and the walkthrough that is running.
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import type { SupportAgentAvailability } from "@opensesame/support-agent";
import type { ReactElement } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconDownload, IconPause, IconX } from "../../components/Icons.js";
import { useSupport } from "../session.js";

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

export function GuideStatus(): ReactElement | null {
  const { view, support } = useSupport();
  const guide = view.guide;
  const live =
    guide?.status === "running" ||
    guide?.status === "waiting" ||
    guide?.status === "paused";
  if (!guide || !live) return null;
  const running = guide.status !== "paused";
  const title = guide.goal
    ? (guideGoal(guide.goal)?.title ?? guide.goal)
    : "Walkthrough";
  return (
    <section className="support__guide" aria-label="Walkthrough in progress">
      <p className="support__guide-head">
        <span className="support__goal-title">{title}</span>
        <span className="support__guide-step">
          {guide.status === "paused" ? "paused · " : ""}
          step {Math.min(guide.index + 1, guide.total)} of {guide.total}
        </span>
      </p>
      {guide.message ? <p className="support__text">{guide.message}</p> : null}
      <div className="actions">
        {running ? (
          <IconKey label="Pause" small onClick={() => support.pauseGuide()}>
            <IconPause size={16} />
          </IconKey>
        ) : null}
        <IconKey label="Stop" small onClick={() => support.stopGuide()}>
          <IconX size={16} />
        </IconKey>
      </div>
    </section>
  );
}
