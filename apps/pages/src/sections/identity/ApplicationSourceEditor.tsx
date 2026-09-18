import { useState } from "react";
import { SourceEditor } from "../../components/configuration/SourceEditor.js";
import {
  parseApplicationSource,
  registrationToYaml,
} from "../../lib/configuration/application-document.js";
import { commitLocalApplicationSource } from "../../lib/configuration/local-application-source.js";
import type { LocalApplicationRegistration } from "../../lib/local-applications.js";

export function ApplicationSourceEditor(props: {
  applicationId: string;
  revision: number;
  registration: LocalApplicationRegistration | undefined;
  disabled: boolean;
  onApply: (registration: LocalApplicationRegistration) => Promise<boolean>;
}) {
  const initial = props.registration
    ? registrationToYaml(props.registration)
    : `# Local application registration. Registration is not consent.\napplicationId: ${props.applicationId}\norganizationId: \nredirectUris: []\nscopes:\n  - openid\n`;
  const [source, setSource] = useState(initial);
  const [message, setMessage] = useState("");
  const parsed = parseApplicationSource(source, props.applicationId);

  async function save() {
    const result = commitLocalApplicationSource(
      {
        revision: () => props.revision,
        configure: () => undefined,
      },
      {
        previousSource: initial,
        source,
        expectedRevision: props.revision,
      },
    );
    if (result.status === "conflict" || result.status === "refused") {
      setMessage(result.message);
      return;
    }
    if (result.message.includes("not invalidated")) {
      setMessage(result.message);
      return;
    }
    if (!parsed.ok) {
      setMessage(parsed.diagnostics[0]?.message ?? "Invalid source.");
      return;
    }
    const saved = await props.onApply(parsed.value);
    setMessage(saved ? result.message : "Could not save registration.");
  }

  return (
    <div>
      <SourceEditor
        id={`app-source-${props.applicationId}`}
        value={source}
        diagnostics={parsed.ok ? [] : parsed.diagnostics}
        onChange={setSource}
        onSave={() => void save()}
        disabled={props.disabled}
      />
      <button
        type="button"
        className="btn btn--primary"
        disabled={props.disabled || !parsed.ok}
        onClick={() => void save()}
      >
        Save source
      </button>
      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}
