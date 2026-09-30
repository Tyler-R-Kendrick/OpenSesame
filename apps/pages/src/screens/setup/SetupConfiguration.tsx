/**
 * The screen in front of the tabbed ceremony: Minimal, Default, Custom.
 * Choice objects, the same road as the front door. No question title.
 */

import {
  IconCheck,
  IconDownload,
  IconSettings,
} from "../../components/Icons.js";
import "../door.css";

export type ConfigurationChoice = "minimal" | "default" | "custom";

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
    id: "custom",
    name: "Custom",
    kind: "the full setup",
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
  return (
    <fieldset className="capset__roads" aria-label="Setup configuration">
      {CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="road"
          aria-label={choice.name}
          aria-describedby={`setup-config-${choice.id}`}
          aria-busy={pending === choice.id}
          disabled={busy}
          onClick={() => onChoose(choice.id)}
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
