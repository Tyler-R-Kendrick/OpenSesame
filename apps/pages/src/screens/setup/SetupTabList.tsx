/**
 * The tab strip of the setup ceremony — one tab per concern, the selected one
 * the roving stop — and the one control a setup tutorial points at to say what
 * the tabs are (`setup.tabs`, ADR 0165).
 */

import type { KeyboardEvent } from "react";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

type TabProps = (at: number) => {
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref: (node: HTMLButtonElement | null) => void;
  tabIndex: number;
};

export function SetupTabList({
  tabs,
  index,
  tabProps,
  select,
}: {
  tabs: readonly { id: string; tab: string }[];
  index: number;
  tabProps: TabProps;
  select: (at: number) => void;
}) {
  const ref = useGuideTarget<HTMLDivElement>("setup.tabs");
  return (
    <div
      ref={ref}
      className="setup__tabs"
      role="tablist"
      aria-label="Setup step"
    >
      {tabs.map((entry, at) => (
        <button
          key={entry.id}
          {...tabProps(at)}
          type="button"
          role="tab"
          aria-selected={at === index}
          className={`setup__tab${at === index ? " setup__tab--active" : ""}`}
          onClick={() => select(at)}
        >
          {entry.tab}
        </button>
      ))}
    </div>
  );
}
