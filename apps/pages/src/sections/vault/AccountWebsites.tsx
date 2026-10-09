import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { testWebsitePattern } from "@opensesame/app-core/lib/vault/website-pattern.js";
import { type LoginUri, type UriMatch, newUri } from "@opensesame/vault-core";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconPlus, IconX } from "../../components/Icons.js";

const MATCHES = [
  "domain",
  "host",
  "exact",
  "wildcard",
  "regex",
  "never",
] as const satisfies readonly UriMatch[];

/** What a rule matches, on the select that picks it — never a line under it. */
const RULE_TITLES = {
  wildcard:
    "Whole hostname, case-insensitive. *.example.com matches subdomains; * matches any characters, ? matches one.",
  regex:
    "Whole hostname, case-insensitive. Use example\\.com or (.*\\.)?example\\.com, without / delimiters or flags.",
} satisfies Partial<Record<UriMatch, string>>;

function PatternTest({ uri }: { uri: LoginUri }) {
  const [website, setWebsite] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <div className="editor__inline">
        <input
          aria-label="Test website"
          maxLength={FIELD_LIMITS.uri}
          value={website}
          placeholder="https://app.example.com"
          onChange={(event) => {
            setWebsite(event.target.value);
            setResult("");
          }}
          disabled={busy}
        />
        <IconKey
          label="Test match"
          disabled={busy || !website.trim()}
          onClick={async () => {
            setBusy(true);
            setResult(await testWebsitePattern(uri, website));
            setBusy(false);
          }}
        >
          <IconCheck size={16} />
        </IconKey>
      </div>
      <output aria-live="polite">{result}</output>
    </div>
  );
}

export function AccountWebsites({
  uris,
  onChange,
}: { uris: LoginUri[]; onChange: (uris: LoginUri[]) => void }) {
  function update(id: string, patch: Partial<LoginUri>) {
    onChange(uris.map((uri) => (uri.id === id ? { ...uri, ...patch } : uri)));
  }
  return (
    <div className="field">
      <span className="label editor__grouplabel">
        Websites
        <IconKey
          label="Add address"
          small
          onClick={() => onChange([...uris, newUri()])}
        >
          <IconPlus size={15} />
        </IconKey>
      </span>
      {uris.map((uri, index) => (
        <div key={uri.id}>
          <div className="editor__uri">
            <input
              value={uri.uri}
              aria-label={`Address ${index + 1}`}
              maxLength={FIELD_LIMITS.uri}
              placeholder={
                uri.match === "wildcard"
                  ? "*.example.com"
                  : uri.match === "regex"
                    ? "(.*\\.)?example\\.com"
                    : "https://example.com"
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update(uri.id, { uri: event.target.value })}
            />
            <select
              value={uri.match}
              aria-label={`Match rule ${index + 1}`}
              title={
                uri.match === "wildcard" || uri.match === "regex"
                  ? RULE_TITLES[uri.match]
                  : undefined
              }
              onChange={(event) => {
                const match = MATCHES.find(
                  (candidate) => candidate === event.target.value,
                );
                if (match) update(uri.id, { match });
              }}
            >
              {MATCHES.map((match) => (
                <option key={match} value={match}>
                  {match}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove address ${index + 1}`}
              onClick={() =>
                onChange(uris.filter((candidate) => candidate.id !== uri.id))
              }
            >
              <IconX size={17} />
            </button>
          </div>
          {uri.match === "wildcard" || uri.match === "regex" ? (
            <PatternTest key={`${uri.uri}:${uri.match}`} uri={uri} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
