import { Fragment, type ReactNode, useState } from "react";

import { IconAlert, IconCheck, IconChevronRight } from "./Icons.js";

/**
 * The one shape every connection ceremony wears.
 *
 * `docs/design/settings-connectivity/Main.dc.html` draws all five connectors as
 * the same object: a card stating what was found with two supporting facts and
 * the primary action inside it, an `or` rule, then the alternatives as rows.
 * Building that shape five times by hand is how five ceremonies drift into five
 * different answers to "what do I do about this" — which is what happened the
 * first time, when four of them degraded into a sentence and a link to
 * Settings.
 *
 * The rule that matters more than the styling: **an alternative expands here,
 * it never navigates.** Repairing a connection is never why you came — the bar
 * told you something was down while you were doing something else — so a
 * ceremony that sends you to another route has handed the problem back. Every
 * alternative renders its own controls inside this sheet, and closing the sheet
 * puts you back where you were.
 */
export type CeremonyFact = {
  key: string;
  /** Rendered in mono: an origin, a duration, an algorithm, a timestamp. */
  value: string;
};

export type CeremonyAlt = {
  id: string;
  label: string;
  icon: ReactNode;
  /** The controls this alternative reveals, inline. Never a route change. */
  render: () => ReactNode;
};

export type CeremonyPrimary = {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
};

export function CeremonyShell({
  ok,
  top,
  name,
  facts,
  primary,
  secondary,
  alts = [],
  children,
}: {
  /** Drives the tick-vs-alert mark and the card's wash. */
  ok: boolean;
  top: string;
  name: string;
  facts?: CeremonyFact[];
  primary?: CeremonyPrimary;
  /**
   * A peer of the primary, for the rare connector with two genuine front
   * doors — Identity has sign-in and guest, and both are first-class. Demoting
   * one into an alternative would cost a click on a path people take daily,
   * which is the whole complaint this shape exists to answer.
   */
  secondary?: CeremonyPrimary;
  alts?: CeremonyAlt[];
  /** Extra content inside the card, below the facts and above the action. */
  children?: ReactNode;
}) {
  return (
    <>
      <div className={`found${ok ? "" : " found--attn"}`}>
        <p className="found__top">
          {ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
          {top}
        </p>
        <p className="found__name">{name}</p>
        {facts && facts.length > 0 ? (
          <dl>
            {/* Fragments, not wrappers: `.found dl` is a two-column grid over
                direct dt/dd children, and it is shared with the machine
                ceremony's card. A div per pair would silently break both. */}
            {facts.map((fact) => (
              <Fragment key={fact.key}>
                <dt>{fact.key}</dt>
                <dd>{fact.value}</dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
        {children}
        {primary || secondary ? (
          <div className="found__do">
            {primary ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={primary.disabled || primary.busy}
                aria-busy={primary.busy}
                onClick={primary.onClick}
              >
                {primary.label}
              </button>
            ) : null}
            {secondary ? (
              <button
                type="button"
                className="btn"
                disabled={secondary.disabled || secondary.busy}
                aria-busy={secondary.busy}
                onClick={secondary.onClick}
              >
                {secondary.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <CeremonyAlts alts={alts} />
    </>
  );
}

/**
 * The alternatives list on its own, for a surface that has a card of its own
 * — a settings panel with its own head and form — but still owes its
 * alternatives the same expand-in-place treatment. One open at a time, and
 * never a navigation: the same rules as inside the shell, because a second
 * dialect of "or do something else" is how the last drift started.
 */
export function CeremonyAlts({ alts }: { alts: CeremonyAlt[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (alts.length === 0) return null;
  return (
    <>
      <p className="or">
        <span>or</span>
      </p>
      <div className="alt">
        {alts.map((entry) => {
          const isOpen = open === entry.id;
          return (
            <div key={entry.id} className="alt__item">
              <button
                type="button"
                className="alt__btn"
                aria-expanded={isOpen}
                aria-controls={`alt-${entry.id}`}
                onClick={() => setOpen(isOpen ? null : entry.id)}
              >
                <span className="alt__mark" aria-hidden="true">
                  {entry.icon}
                </span>
                <span className="alt__grow">{entry.label}</span>
                <span
                  className={`alt__chev${isOpen ? " is-open" : ""}`}
                  aria-hidden="true"
                >
                  <IconChevronRight size={16} />
                </span>
              </button>
              {isOpen ? (
                <div className="alt__body" id={`alt-${entry.id}`}>
                  {entry.render()}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
