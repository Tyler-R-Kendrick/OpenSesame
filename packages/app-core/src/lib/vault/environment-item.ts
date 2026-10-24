/**
 * The Environment vault item (`environment`, ADR 0194 as revised): one
 * varlock-compatible `.env.schema` body, the environment name it belongs to,
 * and explicit bindings from environment keys to named vault item paths.
 *
 * The item stores no values. A key line is the schema's declaration; the
 * alias line only says which vault item holds the value. Rendering inserts
 * the binding as the `@vaultItem` comment varlock understands, so a key whose
 * name differs from the item path still points at the right secret.
 */

import { normalizeEnvironmentName } from "@opensesame/vault-core";

export const ENVIRONMENT_ITEM_TYPE = "environment";

export type EnvironmentAlias = Readonly<{
  key: string;
  path: string;
}>;

export type EnvironmentSchemaValues = Readonly<{
  environment: string;
  schema: string;
  aliases: string;
}>;

export type EnvironmentSchemaFile = Readonly<{
  fileName: string;
  content: string;
}>;

export type EnvironmentSchemaProblem = Readonly<{
  field: "environment" | "schema" | "aliases";
  message: string;
}>;

const KEY = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const ALIAS = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A filesystem-safe item name; separators never escape the download name. */
function filePart(value: string): string {
  return value
    .trim()
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "-")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/^-+|-+$/gu, "");
}

/** `<vault-item-name>.<env-name>.env.schema`, with the environment normalized. */
export function environmentSchemaFileName(
  itemName: string,
  environment: string,
): string {
  const name = filePart(itemName) || "environment";
  const env = normalizeEnvironmentName(environment);
  return env === null ? "" : `${name}.${env}.env.schema`;
}

type SchemaScan = Readonly<{
  keys: readonly string[];
  problems: readonly EnvironmentSchemaProblem[];
}>;

/** Keys a schema declares, and lines that are not a comment, a key, or blank. */
export function scanEnvironmentSchema(schema: string): SchemaScan {
  const keys: string[] = [];
  const seen = new Set<string>();
  const problems: EnvironmentSchemaProblem[] = [];
  if (schema.length > 128 * 1024)
    problems.push({ field: "schema", message: "The schema is too large." });
  const lines = schema
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) return;
    if (CONTROL.test(line)) {
      problems.push({
        field: "schema",
        message: `Line ${index + 1} contains a control character.`,
      });
      return;
    }
    const match = KEY.exec(line);
    if (!match?.[1]) {
      problems.push({
        field: "schema",
        message: `Line ${index + 1} is not a key, comment, or blank line.`,
      });
      return;
    }
    if (seen.has(match[1])) {
      problems.push({
        field: "schema",
        message: `${match[1]} is declared more than once.`,
      });
      return;
    }
    seen.add(match[1]);
    keys.push(match[1]);
  });
  return { keys, problems };
}

/** One `KEY=vault/item/path` binding per line; comments and blank lines ignored. */
export function parseEnvironmentAliases(aliasText: string): Readonly<{
  aliases: readonly EnvironmentAlias[];
  problems: readonly EnvironmentSchemaProblem[];
}> {
  const aliases: EnvironmentAlias[] = [];
  const seen = new Set<string>();
  const problems: EnvironmentSchemaProblem[] = [];
  aliasText
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .forEach((line, index) => {
      const text = line.trim();
      if (text === "" || text.startsWith("#")) return;
      if (CONTROL.test(line)) {
        problems.push({
          field: "aliases",
          message: `Alias line ${index + 1} contains a control character.`,
        });
        return;
      }
      const match = ALIAS.exec(text);
      const path = match?.[2]?.trim() ?? "";
      if (!match?.[1] || path === "") {
        problems.push({
          field: "aliases",
          message: `Alias line ${index + 1} must be KEY=vault/item/path.`,
        });
        return;
      }
      if (seen.has(match[1])) {
        problems.push({
          field: "aliases",
          message: `${match[1]} has more than one binding.`,
        });
        return;
      }
      seen.add(match[1]);
      aliases.push({ key: match[1], path });
    });
  return { aliases, problems };
}

/** The schema with alias bindings inserted above their keys, never a value. */
export function renderEnvironmentSchemaItem(
  itemName: string,
  values: EnvironmentSchemaValues,
): Readonly<{
  file: EnvironmentSchemaFile | null;
  keys: readonly string[];
  aliases: readonly EnvironmentAlias[];
  problems: readonly EnvironmentSchemaProblem[];
}> {
  const { environment, schema } = values;
  const env = normalizeEnvironmentName(environment);
  const scan = scanEnvironmentSchema(schema);
  const parsed = parseEnvironmentAliases(values.aliases);
  const problems: EnvironmentSchemaProblem[] = [
    ...scan.problems,
    ...parsed.problems,
  ];
  if (env === null)
    problems.push({
      field: "environment",
      message: "Use lower-case words joined by - _ or . for the environment.",
    });
  if (scan.keys.length === 0 && scan.problems.length === 0)
    problems.push({
      field: "schema",
      message: "Declare at least one environment key.",
    });
  const known = new Set(scan.keys);
  for (const alias of parsed.aliases) {
    if (!known.has(alias.key))
      problems.push({
        field: "aliases",
        message: `${alias.key} is not declared in the schema.`,
      });
  }
  if (env === null || problems.length > 0)
    return { file: null, keys: scan.keys, aliases: parsed.aliases, problems };

  const byKey = new Map(parsed.aliases.map((alias) => [alias.key, alias.path]));
  const body: string[] = [];
  for (const line of schema
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trimEnd()
    .split("\n")) {
    const key = KEY.exec(line)?.[1];
    const binding = key ? byKey.get(key) : undefined;
    if (binding !== undefined) {
      const previous = body.at(-1);
      if (previous?.trimStart().startsWith("# @vaultItem="))
        body[body.length - 1] = `# @vaultItem=${binding}`;
      else body.push(`# @vaultItem=${binding}`);
    }
    body.push(line);
  }
  return {
    file: {
      fileName: environmentSchemaFileName(itemName, env),
      content: `${body.join("\n")}\n`,
    },
    keys: scan.keys,
    aliases: parsed.aliases,
    problems: [],
  };
}
