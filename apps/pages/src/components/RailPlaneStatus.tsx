import {
  hostStatusLabel,
  identityStatusLabel,
  usePlaneStatus,
} from "../lib/planes.js";

export function RailPlaneStatusDefault() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span
        className={`dot ${status.host === "live" || status.host === "pending" ? "dot--ok" : "dot--warn"}`}
        aria-hidden="true"
      />
      <span>{hostStatusLabel(status.host)}</span>
      <span aria-hidden="true">·</span>
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}
