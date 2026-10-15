import { z } from "zod";
import { assertSafeRunName, validateRunTemplate } from "./startup-env.js";
import { type PasswordAgentPort, invoke } from "./transport.js";
export interface Assignment {
  name: string;
  reference: string;
}
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function parseAssignment(assignment: string): Assignment {
  const equals = assignment.indexOf("=");
  const name = assignment.slice(0, equals);
  const reference = assignment.slice(equals + 1);
  if (
    equals < 1 ||
    !namePattern.test(name) ||
    !/^(?:op|os):\/\//.test(reference) ||
    /[\r\n\0]/.test(reference)
  )
    throw new Error("Expected a valid NAME=op:// or NAME=os:// assignment");
  return { name, reference };
}
function parseEnv(content: string) {
  return content.split(/\r?\n/).map((literal) => {
    const trimmed = literal.trim();
    if (!trimmed || trimmed.startsWith("#")) return { literal };
    const line = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const equals = line.indexOf("=");
    const name = line.slice(0, equals).trim();
    let reference = line.slice(equals + 1).trim();
    if (
      reference.length >= 2 &&
      ((reference.startsWith('"') && reference.endsWith('"')) ||
        (reference.startsWith("'") && reference.endsWith("'")))
    )
      reference = reference.slice(1, -1);
    return equals > 0 &&
      namePattern.test(name) &&
      /^(?:op|os):\/\//.test(reference)
      ? { name, reference }
      : { literal };
  });
}
export function envAssignments(content: string): Assignment[] {
  return parseEnv(content).flatMap((line) =>
    line.name !== undefined && line.reference !== undefined
      ? [{ name: line.name, reference: line.reference }]
      : [],
  );
}
export function renderEnv(assignments: readonly Assignment[]): string {
  return `${assignments
    .map(({ name, reference }) => {
      parseAssignment(`${name}=${reference}`);
      return `${name}=${reference}`;
    })
    .join("\n")}\n`;
}
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
}
export async function resolveEnv(
  content: string,
  resolve: (references: readonly string[]) => Promise<readonly string[]>,
) {
  const lines = parseEnv(content);
  const references = [
    ...new Set(envAssignments(content).map(({ reference }) => reference)),
  ];
  const values = references.length ? await resolve(references) : [];
  if (
    values.length !== references.length ||
    !z.array(z.string()).safeParse(values).success
  )
    throw new Error("Secret resolver returned an invalid batch");
  const lookup = new Map(
    references.map((reference, index) => [reference, values[index] ?? ""]),
  );
  return {
    content: lines
      .map((line) =>
        line.literal !== undefined
          ? line.literal
          : `${line.name}=${quote((lookup.get(line.reference ?? "") ?? "").replace(/\n$/, ""))}`,
      )
      .join("\n"),
    count: envAssignments(content).length,
  };
}
/** The three percent-decoded segments of an `os://vault/item/field` reference. */
export interface OsReference {
  vault: string;
  item: string;
  field: string;
}
export function parseOsReference(reference: string): OsReference {
  const match = /^os:\/\/([^/\r\n\0]+)\/([^/\r\n\0]+)\/([^/\r\n\0]+)$/.exec(
    reference,
  );
  if (!match)
    throw new Error("Expected an os://vault/item/field secret reference");
  try {
    const [vault, item, field] = [
      decodeURIComponent(match[1] ?? ""),
      decodeURIComponent(match[2] ?? ""),
      decodeURIComponent(match[3] ?? ""),
    ];
    if (!vault || !item || !field) throw new Error("empty segment");
    return { vault, item, field };
  } catch {
    throw new Error("Expected an os://vault/item/field secret reference");
  }
}
function isOsReference(reference: string): boolean {
  return reference.startsWith("os://");
}
/** Resolve op:// references in one provider batch and os:// references locally. */
export async function resolveReferences(
  port: PasswordAgentPort,
  references: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(references)];
  const values = new Map<string, string>();
  const remote = unique.filter((reference) => reference.startsWith("op://"));
  const local = unique.filter(isOsReference);
  if (remote.length + local.length !== unique.length)
    throw new Error("Secret references must use op:// or os://");
  if (remote.length) {
    if (!port.readMany)
      throw new Error("Batched secret resolution is unavailable");
    let batch: readonly string[];
    try {
      batch = await port.readMany(remote);
    } catch {
      throw new Error("Batched secret resolution failed (details suppressed)");
    }
    if (batch.length !== remote.length)
      throw new Error("Batched secret resolution failed (details suppressed)");
    remote.forEach((reference, index) =>
      values.set(reference, batch[index] ?? ""),
    );
  }
  if (local.length) {
    if (!port.readLocal)
      throw new Error("The local vault resolver is unavailable.");
    for (const reference of local) {
      parseOsReference(reference);
      values.set(reference, await port.readLocal(reference));
    }
  }
  return values;
}
export async function read(
  port: PasswordAgentPort,
  reference: string,
): Promise<string> {
  if (isOsReference(reference)) {
    parseOsReference(reference);
    if (!port.readLocal)
      throw new Error("The local vault resolver is unavailable.");
    return port.readLocal(reference);
  }
  if (!reference.startsWith("op://") || /[\r\n\0]/.test(reference))
    throw new Error("Expected an op:// secret reference");
  return invoke(port, ["read", reference]);
}
export async function run(
  port: PasswordAgentPort,
  assignments: readonly Assignment[],
  command: readonly string[],
  mounts: readonly Assignment[] = [],
): Promise<number> {
  if (!command.length)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  for (const assignment of [...assignments, ...mounts]) {
    assertSafeRunName(assignment.name);
    parseAssignment(`${assignment.name}=${assignment.reference}`);
  }
  const envNames = new Set(assignments.map(({ name }) => name));
  if (mounts.some(({ name }) => envNames.has(name)))
    throw new Error("A name cannot be both an env value and a mount.");
  const localLane =
    mounts.length > 0 ||
    assignments.some(({ reference }) => isOsReference(reference));
  if (!localLane) {
    if (!port.run)
      throw new Error(
        "Process execution is unavailable or no command was supplied",
      );
    return port.run(
      ["run"],
      command,
      Object.fromEntries(
        assignments.map(({ name, reference }) => [name, reference]),
      ),
    );
  }
  if (!port.runWithValues)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  const resolved = await resolveReferences(port, [
    ...assignments.map(({ reference }) => reference),
    ...mounts.map(({ reference }) => reference),
  ]);
  const mountValues = mounts.map(({ name, reference }) => ({
    name,
    value: resolved.get(reference) ?? "",
  }));
  return port.runWithValues(
    command,
    Object.fromEntries(
      assignments.map(({ name, reference }) => [
        name,
        resolved.get(reference) ?? "",
      ]),
    ),
    mountValues,
    [
      ...assignments.map(({ reference }) => resolved.get(reference) ?? ""),
      ...mountValues.map(({ value }) => value),
    ],
  );
}
function literalValue(
  literal: string,
): { name: string; value: string } | undefined {
  const trimmed = literal.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const line = trimmed.startsWith("export ")
    ? trimmed.slice(7).trim()
    : trimmed;
  const equals = line.indexOf("=");
  if (equals < 1) return undefined;
  const name = line.slice(0, equals).trim();
  if (!namePattern.test(name)) return undefined;
  let value = line.slice(equals + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    value = value.slice(1, -1);
  return { name, value };
}
export async function runFile(
  port: PasswordAgentPort,
  file: string,
  command: readonly string[],
  content: string,
): Promise<number> {
  validateRunTemplate(content);
  const assignments = envAssignments(content);
  if (!assignments.some(({ reference }) => isOsReference(reference))) {
    if (!port.runEnvFile || !file || !command.length)
      throw new Error(
        "Process execution is unavailable or no command was supplied",
      );
    return port.runEnvFile(content, command);
  }
  if (!port.runWithValues || !file || !command.length)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  const resolved = await resolveReferences(
    port,
    assignments.map(({ reference }) => reference),
  );
  const values: Record<string, string> = {};
  for (const line of parseEnv(content)) {
    if (line.name !== undefined && line.reference !== undefined) {
      assertSafeRunName(line.name);
      values[line.name] = resolved.get(line.reference) ?? "";
    } else if (line.literal !== undefined) {
      const literal = literalValue(line.literal);
      if (literal) values[literal.name] = literal.value;
    }
  }
  return port.runWithValues(command, values, [], [...resolved.values()]);
}
