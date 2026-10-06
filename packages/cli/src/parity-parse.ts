import type { GlobalFlags } from "./parse.js";

export type ParityCommand = {
  name: "parity";
  verb: string;
  args: string[];
  flags: GlobalFlags;
};
const VERBS = new Set([
  "find",
  "inventory",
  "audit",
  "create",
  "password",
  "read",
  "run",
  "env",
  "service-account",
  "doctor",
  "request",
  "lease",
]);
export function parseParity(
  verb: string,
  args: string[],
  flags: GlobalFlags,
): ParityCommand | undefined {
  if (!VERBS.has(verb)) return undefined;
  return { name: "parity", verb, args, flags };
}
export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}
export function toggle(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
export function exhausted(args: readonly string[]): void {
  if (args.length) throw new Error("Unexpected command arguments.");
}
export function source(args: string[]): "stdin" | "clipboard" {
  const stdin = toggle(args, "--stdin");
  const clipboard = toggle(args, "--clipboard");
  if (stdin === clipboard)
    throw new Error("Choose exactly one of --stdin or --clipboard.");
  return stdin ? "stdin" : "clipboard";
}
