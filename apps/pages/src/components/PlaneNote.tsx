import { Link } from "react-router";
import {
  PAGES_CANNOT_HOST,
  hostStatusLabel,
  identityStatusLabel,
  usePlaneStatus,
} from "../lib/planes.js";
import { IconAlert } from "./Icons.js";

export function RailPlaneStatus() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span
        className={`dot ${status.host === "live" ? "dot--ok" : "dot--warn"}`}
        aria-hidden="true"
      />
      <span>{hostStatusLabel(status.host)}</span>
      <span aria-hidden="true">·</span>
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}

export function PagesCannotHostNote({
  ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  if (status.host === "live" && status.identity === "connected") return null;
  return (
    <output className="note note--warn">
      <IconAlert />
      <div>
        <p>
          {ceremony} needs the Host API. {PAGES_CANNOT_HOST}
        </p>
        <p>
          Configured Host: <code>{status.hostBase}</code> (
          {hostStatusLabel(status.host).toLowerCase()}).{" "}
          <Link to="/settings">Change it in Settings</Link>.
        </p>
      </div>
    </output>
  );
}
