/**
 * The vault's `.env.schema`, as generated from its keys and environments.
 * Read-only: it holds no value, and an edit belongs on the key it describes.
 */

import { useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconCopy } from "../../components/Icons.js";

const SHOWN_MS = 1600;

export function SchemaBlock({ schema }: Readonly<{ schema: string }>) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(schema);
      setFailed(null);
      setCopied(true);
    } catch {
      setFailed("The schema could not be copied.");
    }
  };

  return (
    <section className="env__schema" aria-label=".env.schema">
      <div className="env__schemahead">
        <h3>.env.schema</h3>
        <IconKey label="Copy .env.schema" onClick={() => void copy()}>
          {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
        </IconKey>
      </div>
      <pre className="env__pre">{schema}</pre>
      <FailureNotice
        id="vault.environments.copy"
        title="Environments"
        message={failed}
      />
    </section>
  );
}
