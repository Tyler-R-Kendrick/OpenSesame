/**
 * Status chrome for the Support sheet: WebMCP, model availability, and the
 * live walkthrough strip.
 */

import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  subscribeWebMcpRegistration,
  webmcpRegistrationSnapshot,
} from "@opensesame/app-core/webmcp/registration.js";
import type { SupportAgentAvailability } from "@opensesame/support-agent";
import { type ReactElement, useSyncExternalStore } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconDownload, IconPause, IconX } from "../../components/Icons.js";
import { useSupport } from "../session.js";
import { UNAVAILABLE_TEXT, webmcpStatusText } from "./messages.js";

/**
 * What this page has registered with the browser's model context. The same
 * fact the DevTools WebMCP panel reports, shown where a person can see it
 * without DevTools — and where "no tools detected" can be told apart from "no
 * model context in this browser".
 */
export function WebMcpStatus(): ReactElement {
  const snapshot = useSyncExternalStore(
    subscribeWebMcpRegistration,
    webmcpRegistrationSnapshot,
    webmcpRegistrationSnapshot,
  );
  return (
    <p className="hint support__webmcp" aria-label="WebMCP status">
      {webmcpStatusText(snapshot)}
    </p>
  );
}

export function Availability({
  availability,
  ready,
  onAcquire,
}: {
  availability: SupportAgentAvailability | null;
  ready: boolean;
  onAcquire: () => void;
}): ReactElement | null {
  if (availability === null) {
    return (
      <p className="hint">
        {ready ? "Nothing has reported yet." : "Checking what can answer here…"}
      </p>
    );
  }
  if (availability.kind === "ready") return null;
  if (availability.kind === "downloading") {
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
  if (availability.kind === "downloadable") {
    return (
      <div className="support__download">
        <p className="hint">
          This browser can answer on the device once its model has been
          downloaded. Nothing is fetched until you ask for it.
        </p>
        <FormCommit
          label="Download the on-device model"
          icon={<IconDownload size={18} />}
          onClick={onAcquire}
        />
      </div>
    );
  }
  return (
    <p className="hint support__unavailable">
      {UNAVAILABLE_TEXT[availability.reason]}
    </p>
  );
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
