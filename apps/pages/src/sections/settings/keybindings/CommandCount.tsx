import { useState } from "react";

/** Zero-width: changes the text a reader compares, never what is drawn. */
const ZERO_WIDTH = "​";

/**
 * How many commands the table shows, announced politely. A live region says
 * nothing when its text is unchanged, so a second search that finds as many
 * as the first would be silent: `signal` names what the table was asked, and
 * each new ask alternates an invisible mark so the count is said again.
 */
export function CommandCount({
  shown,
  signal,
}: {
  shown: number;
  signal: string;
}) {
  const [heard, setHeard] = useState({ signal, odd: false });
  if (heard.signal !== signal) setHeard({ signal, odd: !heard.odd });
  return (
    <output className="kb-count" aria-live="polite">
      {shown} {shown === 1 ? "command" : "commands"}
      {heard.odd ? ZERO_WIDTH : ""}
    </output>
  );
}
