import { identityStatusLabel, usePlaneStatus } from "../lib/planes.js";

export function RailPlaneStatusDefault() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}
