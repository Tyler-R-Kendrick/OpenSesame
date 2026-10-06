/**
 * Settings › Capabilities › Endpoints — the two addresses an operator may
 * point this page at: the connections service and the local agent. They were
 * keys in the directory's `config.yaml`, and that file's view is the page, so
 * each is a row here: an address, saved when the field is left, with no
 * second Save to press. Nothing is asked of an address that is only set
 * (setting one probes nothing); it is read when something needs it.
 */
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";

const TRAILING_SLASH = /\/$/;

function Address({
  id,
  label,
  field,
}: {
  id: string;
  label: string;
  field: "hostApi" | "daemonApi";
}) {
  const [value, setValue] = useState(() => loadSettings()[field]);
  return (
    <FieldShell
      id={id}
      label={label}
      type="url"
      mono
      value={value}
      onValueChange={setValue}
      onCommit={(raw) => {
        const next = raw.trim().replace(TRAILING_SLASH, "");
        setValue(next);
        const current = loadSettings();
        if (current[field] === next) return;
        saveSettings({ ...current, [field]: next });
      }}
    />
  );
}

export function EndpointsPanel() {
  return (
    <section className="panel" id="settings-endpoints">
      <div className="panel__head">
        <h2>Endpoints</h2>
      </div>
      <div className="panel__body">
        <Address
          id="settings-endpoint-connections"
          label="Connections service"
          field="hostApi"
        />
        <Address
          id="settings-endpoint-agent"
          label="Local agent"
          field="daemonApi"
        />
      </div>
    </section>
  );
}
