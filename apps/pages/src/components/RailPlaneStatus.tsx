import { identityStatusLabel } from "../lib/planes.js";

import { usePlaneStatus } from "../bindings/planes.js";
export function RailPlaneStatusDefault() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}
