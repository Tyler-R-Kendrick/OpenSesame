/**
 * The screen in front of the tabbed ceremony: Minimal, Default, Full,
 * Custom. Choice objects, the same road as the front door. No question
 * title.
 *
 * The choices are one keyboard group: Tab reaches them in document
 * order (the door's roads are the same), and the arrow keys walk
 * the row — Left/Right by one, Home/End to the edges — so the
 * whole row is reachable without Tab-ing through every road.
 */

import { type KeyboardEvent, useRef } from "react";
import {
  IconCheck,
  IconDownload,
  IconLayers,
  IconSettings,
} from "../../components/Icons.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import "../door.css";

export type ConfigurationChoice = "minimal" | "default" | "full" | "custom";

const CHOICES: ReadonlyArray<{
  id: ConfigurationChoice;
  name: string;
  kind: string;
  Icon: typeof IconCheck;
}> = [
  {
    id: "minimal",
    name: "Minimal",
    kind: "vault, activity, settings",
    Icon: IconCheck,
  },
  {
    id: "default",
    name: "Default",
    kind: "minimal, plus the default extensions",
    Icon: IconDownload,
  },
  {
    id: "full",
    name: "Full",
    kind: "everything enabled",
    Icon: IconLayers,
  },
  {
    id: "custom",
    name: "Custom",
    kind: "pick individual capabilities",
    Icon: IconSettings,
  },
];

export function SetupConfiguration({
  busy,
  pending,
  onChoose,
}: {
  busy: boolean;
  pending: ConfigurationChoice | null;
  onChoose: (id: ConfigurationChoice) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const targetRef = useGuideTarget<HTMLFieldSetElement>("setup.configurations");
  const move = (event: KeyboardEvent, at: number) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? CHOICES.length - 1
          : null;
    if (step === 0 && edge === null) return;
    event.preventDefault();
    const next = edge ?? (at + step + CHOICES.length) % CHOICES.length;
    const choice = CHOICES[next];
    if (!choice) return;
    refs.current[next]?.focus();
  };
  return (
    <fieldset
      ref={targetRef}
      className="capset__roads"
      aria-label="Setup configuration"
    >
      {CHOICES.map((choice, at) => (
        <button
          key={choice.id}
          ref={(node) => {
            refs.current[at] = node;
          }}
          type="button"
          className="road"
          aria-label={choice.name}
          aria-describedby={`setup-config-${choice.id}`}
          aria-busy={pending === choice.id}
          disabled={busy}
          onClick={() => onChoose(choice.id)}
          onKeyDown={(event) => move(event, at)}
        >
          <span className="road__mark" aria-hidden="true">
            <choice.Icon size={20} />
          </span>
          <span className="road__name">{choice.name}</span>
          <span className="road__kind" id={`setup-config-${choice.id}`}>
            {choice.kind}
          </span>
        </button>
      ))}
    </fieldset>
  );
}
