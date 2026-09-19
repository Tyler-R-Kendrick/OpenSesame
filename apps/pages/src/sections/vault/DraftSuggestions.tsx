import { useEffect, useRef, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { suggestDraftLabels } from "../../lib/vault/draft-suggestions.js";
import {
  type DraftLabels,
  acceptsDraftUsername,
  draftWebsite,
} from "../../lib/vault/new-draft.js";

type Props = {
  typeId: string;
  website?: string;
  onApply: (labels: DraftLabels) => void;
};

/**
 * The origin a suggestion may know about, or nothing. A login's Websites row
 * defaults to a wildcard, and the URL parser happily percent-encodes `*` into
 * a hostname — `https://%2A` reached the hint on every new login. Only a
 * plain hostname is context; a pattern or an invalid value is not.
 */
export function suggestionOrigin(website: string): string {
  try {
    const url = draftWebsite(website);
    return /^[a-z0-9.-]+$/i.test(url.hostname) ? url.origin : "";
  } catch {
    return "";
  }
}

/** A preview first: a delayed model response never overwrites the form. */
export function DraftSuggestions({ typeId, website, onApply }: Props) {
  const [labels, setLabels] = useState<DraftLabels | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, []);
  const origin = website ? suggestionOrigin(website) : "";
  async function suggest() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setLabels(null);
    setMessage("");
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const result = await suggestDraftLabels(
        { typeId, website: origin || undefined },
        controller.signal,
        true,
      );
      if (!controller.signal.aborted) setLabels(result);
    } catch {
      if (request.current === controller)
        setMessage(
          "On-device suggestions are unavailable. Keep the generated defaults or enter your own.",
        );
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        className="btn btn--sm editor__optional"
        disabled={busy}
        onClick={() => void suggest()}
      >
        <IconRefresh size={15} />
        {busy ? "Suggesting…" : "Suggest names on device"}
      </button>
      <p className="hint">
        Uses only the item type{origin ? ` and ${origin}` : ""}. No vault
        contents. Your browser may download its model.
      </p>
      {message ? <output className="hint">{message}</output> : null}
      {labels ? (
        <div className="editor__inline">
          <span>
            {labels.name}
            {acceptsDraftUsername(typeId) ? ` · ${labels.username}` : ""}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              onApply(labels);
              setLabels(null);
            }}
          >
            Use names
          </button>
        </div>
      ) : null}
    </div>
  );
}
