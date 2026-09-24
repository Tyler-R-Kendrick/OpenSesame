import { suggestDraftLabels } from "@opensesame/app-core/lib/vault/draft-suggestions.js";
import {
  type DraftLabels,
  acceptsDraftUsername,
  draftWebsite,
} from "@opensesame/app-core/lib/vault/new-draft.js";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconRefresh } from "../../components/Icons.js";

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
      {/* What the model is given, then the key that asks it: one row, so
          the key ends the sentence it acts on (DESIGN.md § Keys have a
          home). */}
      <div className="keyed-row">
        <p className="hint editor__suggest-note">
          Uses only the item type{origin ? ` and ${origin}` : ""}. No vault
          contents. Your browser may download its model.
        </p>
        <IconKey
          label={busy ? "Suggesting names" : "Suggest names on device"}
          small
          disabled={busy}
          onClick={() => void suggest()}
        >
          <IconRefresh size={15} />
        </IconKey>
      </div>
      {message ? <output className="hint">{message}</output> : null}
      {labels ? (
        <div className="editor__inline">
          <span>
            {labels.name}
            {acceptsDraftUsername(typeId) ? ` · ${labels.username}` : ""}
          </span>
          <IconKey
            label="Use names"
            small
            onClick={() => {
              onApply(labels);
              setLabels(null);
            }}
          >
            <IconCheck size={16} />
          </IconKey>
        </div>
      ) : null}
    </div>
  );
}
