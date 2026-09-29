import { StatusMark } from "../../../components/StatusMark.js";
import type { TravelNotice } from "./TravelViews.js";

/**
 * A refusal or a half-finished step, as a mark under a ceremony's facts —
 * never a paragraph. The words are its accessible name and its tooltip.
 */
export function TravelNoticeMark({ notice }: { notice: TravelNotice | null }) {
  if (!notice) return null;
  const text = notice.meta ? `${notice.text} · ${notice.meta}` : notice.text;
  return (
    <p
      className="vexport__marks"
      role={notice.tone === "err" ? "alert" : undefined}
    >
      <StatusMark tone={notice.tone} label={text} />
    </p>
  );
}
