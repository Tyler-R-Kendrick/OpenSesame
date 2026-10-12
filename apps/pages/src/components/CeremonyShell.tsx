import { Fragment, type ReactNode, type RefObject, useState } from "react";

import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconTrash,
  IconX,
} from "./Icons.js";

/**
 * The one shape every connection ceremony wears.
 *
 * `docs/design/canvases/settings-connectivity/Main.dc.html` draws all five connectors as
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
  /**
   * The verb. It is the key's accessible name and tooltip, and, for the
   * primary, the words set beside the `.go` square in the margin voice —
   * never paint on a button face (DESIGN.md § Actions are symbols).
   */
  label: string;
  /** The glyph on the key; a check, or a bin for `danger`, when left out. */
  icon?: ReactNode;
  /**
   * The words are the thing chosen — a sign-in method, the guest road, one
   * of two kinds of key — not a verb, so the control stays text
   * (`choice`), as `design-lint` accepts it.
   */
  choice?: boolean;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  /**
   * `danger` for the one irreversible act a ceremony can hold — removing a
   * key or a second step — drawn as the ordinary `.go` square with the bin
   * glyph. It is never red and has no Keep key beside it: the sheet's close
   * key is the way out. A card that asks has not failed: it drops the wash
   * and the kicker.
   */
  tone?: "danger";
  /** Submit a surrounding form instead of clicking, so Enter in a field commits. */
  submit?: boolean;
  /**
   * A ref to the drawn button. A confirmation sheet lands the keyboard on
   * the safe key, not the danger one beside it, so the caller passes the
   * safe key's ref and the sheet that hosts the shell focuses it on open.
   */
  keyRef?: RefObject<HTMLButtonElement | null>;
};

export function CeremonyShell({
  ok = true,
  top,
  name,
  facts,
  primary,
  secondary,
  alts = [],
  children,
}: {
  /** Drives the tick-vs-alert mark and the card's wash. */
  ok?: boolean;
  /**
   * The top line is a fact — "Enrolled 28 Aug", "Code sent", "7 of 10 left"
   * — or nothing. A card for something that has not happened yet leaves it
   * out rather than wearing a kicker.
   */
  top?: string;
  name: string;
  facts?: CeremonyFact[];
  primary?: CeremonyPrimary;
  /**
   * A peer of the primary, for the rare connector with two genuine front
   * doors — Identity has sign-in and "Use this device", and both are
   * first-class. Demoting one into an alternative would cost a click on a
   * path people take daily, which is the whole complaint this shape exists
   * to answer. The guest tomb is not this door: that is Skip.
   */
  secondary?: CeremonyPrimary;
  alts?: CeremonyAlt[];
  /** Extra content inside the card, below the facts and above the action. */
  children?: ReactNode;
}) {
  const asks = primary?.tone === "danger";
  const wash = asks ? " found--ask" : ok ? "" : " found--attn";
  return (
    <>
      <div className={`found${wash}`}>
        {top ? (
          <p className="found__top">
            {ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
            {top}
          </p>
        ) : null}
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
          <CeremonyKeys primary={primary} secondary={secondary} />
        ) : null}
      </div>

      <CeremonyAlts alts={alts} />
    </>
  );
}

/**
 * A ceremony's keys, on one row: the primary is the `.go` square with its
 * verb beside it — the same object at the foot of every form (`FormCommit`)
 * — and the secondary (keep, dismiss, download) is an icon key on the same
 * row. A key whose words are the thing chosen stays text (`choice`).
 */
function CeremonyKeys({
  primary,
  secondary,
}: {
  primary?: CeremonyPrimary;
  secondary?: CeremonyPrimary;
}) {
  return (
    <div className="go-row found__do">
      {primary ? <PrimaryKey primary={primary} /> : null}
      {secondary ? <SecondaryKey secondary={secondary} /> : null}
    </div>
  );
}

function PrimaryKey({ primary }: { primary: CeremonyPrimary }) {
  if (primary.choice) return <ChoiceKey entry={primary} primary />;
  const danger = primary.tone === "danger";
  return (
    <>
      <button
        ref={primary.keyRef}
        type={primary.submit ? "submit" : "button"}
        className="go"
        disabled={primary.disabled || primary.busy}
        aria-busy={primary.busy || undefined}
        aria-label={primary.label}
        title={primary.label}
        onClick={primary.submit ? undefined : primary.onClick}
      >
        {primary.icon ??
          (danger ? <IconTrash size={18} /> : <IconCheck size={18} />)}
      </button>
      <span className="go-verb" aria-hidden="true">
        {primary.label}
      </span>
    </>
  );
}

function SecondaryKey({ secondary }: { secondary: CeremonyPrimary }) {
  if (secondary.choice) return <ChoiceKey entry={secondary} />;
  return (
    <button
      ref={secondary.keyRef}
      type="button"
      className="icon-btn"
      disabled={secondary.disabled || secondary.busy}
      aria-busy={secondary.busy || undefined}
      aria-label={secondary.label}
      title={secondary.label}
      onClick={secondary.onClick}
    >
      {secondary.icon ?? <IconX size={18} />}
    </button>
  );
}

/** A key whose words are the thing chosen: a method, a road. */
function ChoiceKey({
  entry,
  primary = false,
}: {
  entry: CeremonyPrimary;
  primary?: boolean;
}) {
  return (
    <button
      ref={entry.keyRef}
      type={entry.submit ? "submit" : "button"}
      className={primary ? "btn btn--primary choice" : "btn choice"}
      disabled={entry.disabled || entry.busy}
      aria-busy={entry.busy || undefined}
      onClick={entry.submit ? undefined : entry.onClick}
    >
      {entry.label}
    </button>
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
