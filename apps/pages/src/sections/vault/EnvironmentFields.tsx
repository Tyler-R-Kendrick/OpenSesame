/**
 * The Environment item's one editor and record view. It draws the varlock
 * schema body, the environment name used in the file name, and the alias
 * bindings from schema keys to named vault item paths. The generated file is a
 * view; no value is ever written into it.
 */

import {
  type EnvironmentAlias,
  type EnvironmentSchemaProblem,
  type EnvironmentSchemaValues,
  renderEnvironmentSchemaItem,
} from "@opensesame/app-core/lib/vault/environment-item.js";
import { asText } from "@opensesame/app-core/sections/vault/typed-field-inputs-model.js";
import { itemPath } from "@opensesame/vault-core";
import type { FieldValue, FieldValues } from "@opensesame/vault-item-types";
import { useEffect, useId, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldRow } from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconCopy, IconDownload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import "./environment-item.css";

const SHOWN_MS = 1800;

function valuesOf(values: FieldValues): EnvironmentSchemaValues {
  return {
    environment: asText(values.environment),
    schema: asText(values.schema),
    aliases: asText(values.aliases),
  };
}

function ProblemList({
  problems,
}: Readonly<{ problems: readonly EnvironmentSchemaProblem[] }>) {
  if (problems.length === 0) return null;
  return (
    <ul className="envschema__problems">
      {problems.map((problem) => (
        <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
      ))}
    </ul>
  );
}

function AliasRows({
  aliases,
}: Readonly<{ aliases: readonly EnvironmentAlias[] }>) {
  if (aliases.length === 0)
    return (
      <span className="frow__value">
        No aliases. Keys keep their own names.
      </span>
    );
  return (
    <ul className="envschema__aliases">
      {aliases.map((alias) => (
        <li key={alias.key}>
          <code>{alias.key}</code>
          <span aria-hidden="true"> → </span>
          <code>{alias.path}</code>
        </li>
      ))}
    </ul>
  );
}

function GeneratedFile({
  itemName,
  values,
  id,
}: Readonly<{
  itemName: string;
  values: EnvironmentSchemaValues;
  id: string;
}>) {
  const result = renderEnvironmentSchemaItem(itemName, values);
  const file = result.file;
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!copied && !downloaded) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setDownloaded(false);
    }, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [copied, downloaded]);

  async function copy() {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setFailed("");
      setCopied(true);
    } catch {
      setFailed(`The ${file.fileName} file could not be copied.`);
    }
  }

  function download() {
    if (!file) return;
    try {
      downloadSeams.save(file.fileName, file.content, "text/plain");
      setFailed("");
      setDownloaded(true);
    } catch {
      setFailed(`The ${file.fileName} file could not be written.`);
    }
  }

  return (
    <section
      className="envschema__file"
      aria-label="Generated environment schema"
    >
      <div className="envschema__filehead">
        <div>
          <span className="label">Generated file</span>
          <h3>{file?.fileName ?? "Complete the schema first"}</h3>
        </div>
        {file ? (
          <div className="envschema__filekeys">
            <IconKey
              label={`Copy ${file.fileName}`}
              onClick={() => void copy()}
            >
              {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
            </IconKey>
            <IconKey label={`Download ${file.fileName}`} onClick={download}>
              {downloaded ? (
                <IconCheck size={17} />
              ) : (
                <IconDownload size={17} />
              )}
            </IconKey>
          </div>
        ) : null}
      </div>
      <ProblemList problems={result.problems} />
      {file ? (
        <>
          <pre>{file.content}</pre>
          {copied ? <StatusMark tone="ok" label="Schema copied" /> : null}
          {downloaded ? (
            <StatusMark tone="ok" label="Schema downloaded" />
          ) : null}
        </>
      ) : null}
      <FailureNotice
        id={`${id}:environment-schema`}
        title="Environment"
        message={failed}
      />
    </section>
  );
}

/** The editable Environment item surface. */
export function EnvironmentFields({
  itemName,
  values,
  onChange,
}: Readonly<{
  itemName: string;
  values: FieldValues;
  onChange: (fieldId: string, value: FieldValue) => void;
}>) {
  const prefix = useId();
  const environmentId = `${prefix}-environment`;
  const schemaId = `${prefix}-schema`;
  const aliasesId = `${prefix}-aliases`;
  const current = valuesOf(values);
  const { items, folders } = useVault();
  const paths = items
    .filter((item) => item.deletedAt === null)
    .map((item) => itemPath(item, folders))
    .sort((left, right) => left.localeCompare(right));

  return (
    <div className="editor__grid envschema">
      <div className="field">
        <label htmlFor={environmentId}>
          Environment <span aria-hidden="true">*</span>
        </label>
        <input
          id={environmentId}
          autoComplete="off"
          spellCheck={false}
          value={current.environment}
          placeholder="production"
          onChange={(event) => onChange("environment", event.target.value)}
        />
        <p className="field__help">
          Lower-case words joined by - _ or . The generated file uses this name.
        </p>
      </div>
      <div className="field">
        <label htmlFor={schemaId}>
          env.schema <span aria-hidden="true">*</span>
        </label>
        <textarea
          id={schemaId}
          rows={10}
          autoComplete="off"
          spellCheck={false}
          value={current.schema}
          placeholder={"# @sensitive @required\nDATABASE_URL="}
          onChange={(event) => onChange("schema", event.target.value)}
        />
        <p className="field__help">
          varlock @env-spec keys, decorators and rules. Never put a value here.
        </p>
      </div>
      <div className="field">
        <label htmlFor={aliasesId}>Vault item aliases</label>
        <textarea
          id={aliasesId}
          rows={4}
          autoComplete="off"
          spellCheck={false}
          value={current.aliases}
          placeholder={"DATABASE_URL=Backend/Database URL"}
          onChange={(event) => onChange("aliases", event.target.value)}
        />
        <p className="field__help">
          One KEY=vault/item/path per line. The key must be in the schema; the
          path may be any named vault item path.
        </p>
        {paths.length > 0 ? (
          <details className="envschema__paths">
            <summary>Known vault paths</summary>
            <ul>
              {paths.slice(0, 40).map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <GeneratedFile itemName={itemName} values={current} id={prefix} />
    </div>
  );
}

/** The read-only Environment record, with the generated file ready to copy. */
export function EnvironmentFieldsRead({
  itemName,
  values,
}: Readonly<{ itemName: string; values: FieldValues }>) {
  const current = valuesOf(values);
  const result = renderEnvironmentSchemaItem(itemName, current);
  return (
    <>
      <section className="detail__group" aria-label="Environment">
        <h2 className="detail__grouphead">Environment</h2>
        <FieldRow label="Name">
          <span className="frow__value">
            {current.environment || "Not set"}
          </span>
        </FieldRow>
        <FieldRow label="Vault item aliases">
          <AliasRows aliases={result.aliases} />
        </FieldRow>
      </section>
      <GeneratedFile
        itemName={itemName}
        values={current}
        id={`${itemName}:detail`}
      />
    </>
  );
}
