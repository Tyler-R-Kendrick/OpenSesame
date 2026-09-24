import type { TransportViewState } from "@opensesame/app-core/lib/transport-rows.js";
import { StatusMark } from "../../../components/StatusMark.js";

/**
 * One row per dimension — desired, credential, runtime, observed,
 * enforcement — each a glyph with its sentence in `aria-label`/`title` and
 * the facts beside it. Never a pill, never a paragraph (DESIGN.md § Status
 * is a symbol); the five never fold into one lifecycle.
 */
export function TransportStatusRows({ view }: { view: TransportViewState }) {
  return (
    <div className="transport__rows" data-target={view.target ?? ""}>
      {view.rows.map((row) => (
        <div
          key={row.id}
          className="sw sw--method transport__row"
          data-dimension={row.id}
          data-tone={row.tone}
        >
          <div>
            <div className="sw__name">
              {row.label}
              <StatusMark tone={row.tone} label={row.state} />
            </div>
            {/* With no facts, the state itself is the row's value — a row of
                bare lock glyphs said nothing without a pointer to hover. */}
            <p className="sw__sub">{row.facts || row.state}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
