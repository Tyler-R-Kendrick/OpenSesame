/**
 * The frame every panel of Settings › Trusted contacts shares: the section
 * the category's rail scrolls to (`id` is the id the category lists), its
 * head, a polite line a screen reader hears changes on, and the body.
 *
 * `keys` ride the head as one group when a panel has any, and the group is
 * absent otherwise: a key that acts is drawn, an empty group is not. `overlay`
 * is where a panel's open sheet is drawn, after the body.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { GuideTarget } from "../../tutorial/registry/react.jsx";

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
  /** The section id the category's panel list names. */
  id: string;
  title: string;
  /** The tutorial target the panel answers to. */
  target: string;
  said: string;
  keys?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <GuideTarget id={target}>
      <section className="panel" id={id} aria-label={title}>
        <div className="panel__head">
          <h2>{title}</h2>
          {keys ? (
            <fieldset className="vtree__keys" aria-label={`${title} commands`}>
              {keys}
            </fieldset>
          ) : null}
        </div>
        <div className="panel__body">
          <output className="visually-hidden" aria-live="polite">
            {said}
          </output>
          {children}
        </div>
        {overlay}
      </section>
    </GuideTarget>
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
