/**
 * The frame every group of Settings › Security › Trusted contacts shares: its
 * heading, a polite line a screen reader hears changes on, and the body.
 *
 * `keys` ride the heading as one actions row when a group has any, and the
 * row is absent otherwise: a key that acts is drawn, an empty row is not.
 * `overlay` is where a group's open sheet is drawn, after the body.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/**
 * `text` as a sentence for a live region, said only when it changes: arriving
 * on a panel is not an event, a circle being added is.
 */
export function useSaid(text: string): string {
  const last = useRef(text);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (last.current === text) return;
    last.current = text;
    setSaid(text);
  }, [text]);
  return said;
}

export function PanelFrame({
  id,
  title,
  target,
  said,
  keys,
  overlay,
  children,
}: {
  /** The group id the section's own page tree names. */
  id: string;
  title: string;
  /** The tutorial target the group answers to. */
  target: string;
  said: string;
  keys?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const targetRef = useGuideTarget<HTMLElement>(target);
  return (
    <section
      ref={targetRef}
      className="trusted-contacts__group"
      id={id}
      aria-label={title}
      aria-labelledby={`${id}-title`}
      data-guide-target={target}
    >
      <div className="trusted-contacts__group-head">
        <h3 id={`${id}-title`}>{title}</h3>
        {keys ? (
          <fieldset
            className="actions trusted-contacts__commands"
            aria-label={`${title} commands`}
          >
            {keys}
          </fieldset>
        ) : null}
      </div>
      <div className="trusted-contacts__group-body">
        <output className="visually-hidden" aria-live="polite">
          {said}
        </output>
        {children}
      </div>
      {overlay}
    </section>
  );
}

/** One row of a panel's list: a name, one line of fact, and the marks for where it stands. */
export function Row({
  name,
  facts,
  marks,
}: {
  name: string;
  facts: string;
  marks: ReactNode;
}) {
  return (
    <li className="tc-row">
      <h3>{name}</h3>
      <span className="tc-row__facts">{facts}</span>
      <span className="tc-row__marks">{marks}</span>
    </li>
  );
}
