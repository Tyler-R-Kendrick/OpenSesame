/**
 * The command that installs a plugin, as an object a person copies to the
 * terminal of the daemon's machine. Pages never installs one itself.
 */

import { useState } from "react";
import { IconCheck, IconCopy } from "../../../components/Icons.js";

const LABEL = "Copy the install command";

export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="plugin-tile__install">
      <code className="plugin-tile__command">{command}</code>
      <button
        type="button"
        className="icon-btn"
        aria-label={LABEL}
        title={LABEL}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
      </button>
    </div>
  );
}
