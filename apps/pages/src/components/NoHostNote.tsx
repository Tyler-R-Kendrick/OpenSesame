/**
 * What a screen says where a Host would be, and there is none.
 *
 * Nothing failed here, so nothing here is red and nothing is announced as an
 * alert: a deployment with no Host is complete (ADR 0090), and this note names
 * what connecting one would add rather than reporting an absence as a fault.
 *
 * It is one component because the first cut of ADR 0090 wrote this note twice
 * by hand, in two voices, and left a third screen still claiming that
 * connections "could not be read" when nothing had been asked of anything.
 * One voice, one road out, one place to change either.
 */

import { Link } from "react-router";

export function NoHostNote({
  what,
  road = true,
}: {
  /** What a Host would add here, in one sentence. */
  what: string;
  /**
   * Show the way to connect one. False where this note already renders on the
   * page that holds the ceremony — a link to where you are standing is noise.
   */
  road?: boolean;
}) {
  return (
    <div className="empty">
      <h3>No Host connected</h3>
      <p className="hint">
        {what} This deployment has none connected, which is fine
        {road ? (
          <>
            {" — connect one under "}
            <Link to="/settings/connectivity">Settings → Connectivity</Link>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
