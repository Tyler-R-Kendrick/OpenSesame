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
    throw new Error("Expected a valid NAME=op://reference assignment");
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
export async function read(
  port: PasswordAgentPort,
  reference: string,
): Promise<string> {
  if (!reference.startsWith("op://") || /[\r\n\0]/.test(reference))
    throw new Error("Expected an op:// secret reference");
  return invoke(port, ["read", reference]);
}
export async function run(
  port: PasswordAgentPort,
  assignments: readonly Assignment[],
  command: readonly string[],
): Promise<number> {
  if (!port.run || !command.length)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  for (const assignment of assignments) {
    assertSafeRunName(assignment.name);
    parseAssignment(`${assignment.name}=${assignment.reference}`);
    if (!assignment.reference.startsWith("op://"))
      throw new Error("1Password process injection requires op:// references");
  }
  return port.run(
    ["run"],
    command,
    Object.fromEntries(
      assignments.map(({ name, reference }) => [name, reference]),
    ),
  );
}
export async function runFile(
  port: PasswordAgentPort,
  file: string,
  command: readonly string[],
  content: string,
): Promise<number> {
  validateRunTemplate(content);
  if (!port.runEnvFile || !file || !command.length)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  return port.runEnvFile(content, command);
}
