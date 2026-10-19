import type {
  LocalCanaryCommand,
  LocalCanaryResult,
} from "@opensesame/vault-core/local-vault-security.js";
import {
  IconDownload,
  IconRefresh,
  IconTrash,
} from "../../../components/Icons.js";
import { CanaryEnrollmentForm } from "./CanaryCredentialForms.js";
function download(value: LocalCanaryResult) {
  if (value.kind !== "pairing" && value.kind !== "configuration") return;
  const data = value.kind === "pairing" ? value.pairing : value.configuration;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    value.kind === "pairing"
      ? "opensesame-canary-pairing.json"
      : "opensesame-canary-configuration.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CanaryResults({
  result,
  choose,
}: {
  result: LocalCanaryResult;
  choose: (action: LocalCanaryCommand["action"]) => void;
}) {
  return (
    <>
      {result.kind === "pairing" || result.kind === "configuration" ? (
        <>
          <label>
            {result.kind === "pairing"
              ? "Receiver pairing document"
              : "Canary configuration"}
            <textarea
              readOnly
              value={JSON.stringify(
                result.kind === "pairing"
                  ? result.pairing
                  : result.configuration,
                null,
                2,
              )}
            />
          </label>
          <button
            className="icon-btn"
            type="button"
            aria-label={
              result.kind === "pairing"
                ? "Download pairing document"
                : "Download canary configuration"
            }
            onClick={() => download(result)}
          >
            <IconDownload size={18} />
          </button>
        </>
      ) : null}
      {result.kind === "enrolled" ? <p>{result.record.label}</p> : null}
      {result.kind === "enrolled" ? (
        <button
          className="icon-btn"
          type="button"
          aria-label="Export enrolled canary"
          onClick={() => choose({ kind: "export", id: result.record.id })}
        >
          <IconDownload size={18} />
        </button>
      ) : null}
      {result.kind === "inspection" ? (
        <CanaryInspection result={result} choose={choose} />
      ) : null}
      <button
        className="icon-btn"
        type="button"
        aria-label="Refresh canaries"
        onClick={() => choose({ kind: "inspect" })}
      >
        <IconRefresh size={18} />
      </button>
    </>
  );
}
function CanaryInspection({
  result,
  choose,
}: {
  result: Extract<LocalCanaryResult, { kind: "inspection" }>;
  choose: (action: LocalCanaryCommand["action"]) => void;
}) {
  return (
    <>
      <h3>Canaries</h3>
      {result.records.length ? (
        <ul>
          {result.records.map((record) => (
            <li key={record.id}>
              {record.label} ·{" "}
              {record.artifactKind === "mcp-config"
                ? "MCP configuration"
                : "Connection reference"}{" "}
              · expires {new Date(record.expiresAt).toLocaleDateString()}
              <button
                className="icon-btn"
                type="button"
                aria-label={`Export ${record.label}`}
                onClick={() => choose({ kind: "export", id: record.id })}
              >
                <IconDownload size={18} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label={`Remove ${record.label}`}
                onClick={() => choose({ kind: "remove", id: record.id })}
              >
                <IconTrash size={18} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No active canaries.</p>
      )}
      {result.inactiveIds.length ? (
        <p>{result.inactiveIds.length} inactive canaries</p>
      ) : null}
      <CanaryEnrollmentForm choose={choose} />
      <h3>Detection activity</h3>
      {result.events.length ? (
        <ul>
          {result.events.map((event) => (
            <li key={`${event.id}-${event.sequence}`}>
              {event.event === "canary_connected"
                ? "Canary connected"
                : "Canary tool invoked"}{" "}
              · {new Date(event.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      ) : (
        <p>No detection activity.</p>
      )}
    </>
  );
}
