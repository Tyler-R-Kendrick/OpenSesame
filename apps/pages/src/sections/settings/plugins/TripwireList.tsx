/**
 * The surrogate proxy's recent tripwires, newest first: which event, when,
 * and about what. The daemon never sends a surrogate or a credential here,
 * and the reader drops a subject that looks like one anyway
 * (`lib/plugins/wire.ts`); a summary is never read at all.
 */

import type { PluginNotice } from "@opensesame/app-core/lib/plugins/wire.js";

function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export function TripwireList({
  notices,
}: {
  notices: readonly PluginNotice[];
}) {
  if (notices.length === 0) return null;
  return (
    <ul className="plugin-tile__tripwires" aria-label="Recent tripwires">
      {notices.map((notice, at) => (
        <li
          // A feed may repeat an event at the same instant; its place keeps
          // the key unique, and the list is replaced whole on each read.
          key={`${notice.at}-${notice.event}-${at}`}
          className="plugin-tile__tripwire"
        >
          <span className="plugin-tile__event">{notice.event}</span>
          <time dateTime={notice.at}>{when(notice.at)}</time>
          {notice.subject ? (
            <span className="plugin-tile__subject">{notice.subject}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
