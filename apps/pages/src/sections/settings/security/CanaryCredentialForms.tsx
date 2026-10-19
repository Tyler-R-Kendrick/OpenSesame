import { parseCanaryReceiverProfile } from "@opensesame/app-core/lib/agent-canaries/receiver-profile-data.js";
import type {
  LocalCanaryCommand,
  LocalCanaryReceiver,
} from "@opensesame/vault-core/local-vault-security.js";
import { useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconArrowRight, IconPlus } from "../../../components/Icons.js";
export function CanaryReceiverForm({
  choose,
}: {
  choose: (receiver: LocalCanaryReceiver, kind: "pairing" | "inspect") => void;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [browserOrigin, setBrowserOrigin] = useState(window.location.origin);
  const [port, setPort] = useState("");
  const [kind, setKind] = useState<"pairing" | "inspect">("inspect");
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const receiver = parseCanaryReceiverProfile({
            endpoint,
            serviceId,
            browserOrigin,
            bindPort: Number(port),
          });
          setError("");
          choose(receiver, kind);
        } catch {
          setError(
            "Enter an exact HTTPS or loopback receiver, service ID, browser origin and matching port.",
          );
        }
      }}
    >
      <FailureNotice
        id="canary-receiver-profile"
        title="Agent canaries"
        message={error}
      />
      <FieldShell
        label="Receiver endpoint"
        value={endpoint}
        onValueChange={setEndpoint}
      />
      <FieldShell
        label="Receiver service ID"
        value={serviceId}
        onValueChange={setServiceId}
      />
      <FieldShell
        label="Allowed browser origin"
        value={browserOrigin}
        onValueChange={setBrowserOrigin}
      />
      <FieldShell
        label="Receiver bind port"
        value={port}
        onValueChange={setPort}
        inputMode="numeric"
      />
      <label>
        Operation
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === "pairing" ? "pairing" : "inspect")
          }
        >
          <option value="inspect">Review canaries</option>
          <option value="pairing">Pair receiver</option>
        </select>
      </label>
      <FormCommit
        label={kind === "pairing" ? "Pair receiver" : "Review canaries"}
        disabled={!endpoint || !serviceId || !browserOrigin || !port}
        icon={<IconArrowRight size={18} />}
      />
    </form>
  );
}
export function CanaryEnrollmentForm({
  choose,
}: { choose: (action: LocalCanaryCommand["action"]) => void }) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("90");
  const [artifact, setArtifact] = useState<
    "mcp-config" | "connection-reference"
  >("mcp-config");
  const [consent, setConsent] = useState(false);
  const retentionDays = Number(days);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !consent ||
          !label ||
          !Number.isInteger(retentionDays) ||
          retentionDays < 1 ||
          retentionDays > 90
        )
          return;
        choose({
          kind: "enroll",
          label,
          artifactKind: artifact,
          retentionDays,
          ownerConsent: true,
        });
      }}
    >
      <FieldShell
        label="Canary name"
        value={label}
        onValueChange={setLabel}
        maxLength={80}
      />
      <label>
        Artifact
        <select
          value={artifact}
          onChange={(event) => {
            setArtifact(
              event.target.value === "connection-reference"
                ? "connection-reference"
                : "mcp-config",
            );
            setConsent(false);
          }}
        >
          <option value="mcp-config">MCP configuration</option>
          <option value="connection-reference">Connection reference</option>
        </select>
      </label>
      <FieldShell
        label="Canary retention in days (1–90)"
        value={days}
        onValueChange={setDays}
        inputMode="numeric"
      />
      <label>
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        I control where this detection-only artifact is placed and consent to
        recording its connections and tool use.
      </label>
      <FormCommit
        label="Add canary"
        icon={<IconPlus size={18} />}
        disabled={
          !consent ||
          !label ||
          !Number.isInteger(retentionDays) ||
          retentionDays < 1 ||
          retentionDays > 90
        }
      />
    </form>
  );
}
