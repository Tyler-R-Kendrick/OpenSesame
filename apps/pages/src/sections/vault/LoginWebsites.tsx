import { useState } from "react";
import { IconPlus, IconX } from "../../components/Icons.js";
import { type LoginUri, type UriMatch, newUri } from "../../lib/vault/model.js";
import { testWebsitePattern } from "../../lib/vault/website-pattern.js";

const MATCHES: UriMatch[] = [
  "domain",
  "host",
  "exact",
  "wildcard",
  "regex",
  "never",
];

function PatternTest({ uri }: { uri: LoginUri }) {
  const [website, setWebsite] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <p className="hint">
        Whole hostname only, case-insensitive.{" "}
        {uri.match === "wildcard"
          ? "*.example.com matches subdomains; * matches any characters, ? matches one."
          : "Use example\\.com or (.*\\.)?example\\.com. No / delimiters or flags."}{" "}
      </p>
      <div className="editor__inline">
        <input
          aria-label="Test website"
          value={website}
          placeholder="https://app.example.com"
          onChange={(event) => {
            setWebsite(event.target.value);
            setResult("");
          }}
          disabled={busy}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || !website.trim()}
          onClick={async () => {
            setBusy(true);
            setResult(await testWebsitePattern(uri, website));
            setBusy(false);
          }}
        >
          Test match
        </button>
      </div>
      <output aria-live="polite">{result}</output>
    </div>
  );
}

export function LoginWebsites({
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
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Add address"
          title="Add address"
          onClick={() => onChange([...uris, newUri()])}
        >
          <IconPlus size={15} />
        </button>
      </span>
      {uris.map((uri, index) => (
        <div key={uri.id}>
          <div className="editor__uri">
            <input
              value={uri.uri}
              aria-label={`Address ${index + 1}`}
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
