/**
 * The vault's generated `.env.<name>.schema` files, one per environment.
 * Read-only: they hold no values, and an edit belongs on the key they describe.
 */

import type { EnvironmentSchema } from "@opensesame/app-core/lib/vault/environments.js";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconCopy } from "../../components/Icons.js";

const SHOWN_MS = 1600;

function SchemaFile({ environment, schema }: Readonly<EnvironmentSchema>) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const name = `.env.${environment}.schema`;
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
      setFailed(`The ${name} file could not be copied.`);
    }
  };

  return (
    <section className="env__schema" aria-label={name}>
      <div className="env__schemahead">
        <h3>{name}</h3>
        <IconKey label={`Copy ${name}`} onClick={() => void copy()}>
          {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
        </IconKey>
      </div>
      <pre className="env__pre">{schema}</pre>
      <FailureNotice
        id={`vault.environments.copy.${environment}`}
        title="Environments"
        message={failed}
      />
    </section>
  );
}

export function SchemaBlock({
  schemas,
}: Readonly<{ schemas: readonly EnvironmentSchema[] }>) {
  return (
    <div className="env__schemas">
      {schemas.map((entry) => (
        <SchemaFile
          key={entry.environment}
          environment={entry.environment}
          schema={entry.schema}
        />
      ))}
    </div>
  );
}
