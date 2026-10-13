/** Provider credentials must never reach interpreter startup hooks. */
import { passwordAgentPolicy } from "./policy.js";
const reserved = new Set(passwordAgentPolicy.credentialStartupEnvKeys);
const nameQuotes = new Set(['"', "'", "`"]);
export function assertSafeRunName(name: string): void {
  if (reserved.has(name.toUpperCase()))
    throw new Error(
      "Interpreter startup environment variables cannot be injected into credential-bearing processes.",
    );
}
function validName(name: string): boolean {
  if (!/^[A-Za-z_]/.test(name)) return false;
  return /^[A-Za-z0-9_]*$/.test(name.slice(1));
}
function trimAssignmentName(raw: string): string {
  let name = raw.trim();
  while (name.length > 0 && nameQuotes.has(name.charAt(0)))
    name = name.slice(1);
  while (name.length > 0 && nameQuotes.has(name.charAt(name.length - 1)))
    name = name.slice(0, -1);
  return name;
}
function templateAssignment(
  line: string,
): { name: string; value: string } | undefined {
  let rest = line.replace(/^\uFEFF/, "").trimStart();
  if (rest.startsWith("#")) return undefined;
  if (rest.startsWith("export")) {
    const afterExport = rest.slice("export".length);
    if (/^\s/.test(afterExport)) rest = afterExport.trimStart();
  }
  const equals = rest.indexOf("=");
  const colon = rest.indexOf(":");
  const separator =
    equals < 0 ? colon : colon < 0 ? equals : Math.min(equals, colon);
  if (separator < 0) return undefined;
  const name = trimAssignmentName(rest.slice(0, separator));
  if (!validName(name)) return undefined;
  return { name, value: rest.slice(separator + 1).trimStart() };
}
function hasClosingQuote(value: string, quote: string): boolean {
  // Treat even an escaped delimiter as a close: provider dotenv dialects differ,
  // so ambiguity must never hide a subsequent startup-variable assignment.
  return value.includes(quote);
}
function pendingMultilineQuote(value: string): string | undefined {
  const quote = value[0];
  if (
    (quote === "'" || quote === '"') &&
    !hasClosingQuote(value.slice(1), quote)
  )
    return quote;
  return undefined;
}
export function validateRunTemplate(content: string): void {
  let multilineQuote: string | undefined;
  for (const literal of content.split(/[\r\n]/)) {
    if (multilineQuote) {
      if (hasClosingQuote(literal, multilineQuote)) multilineQuote = undefined;
      continue;
    }
    const assignment = templateAssignment(literal);
    if (!assignment) continue;
    assertSafeRunName(assignment.name);
    multilineQuote = pendingMultilineQuote(assignment.value);
  }
}
