import { type Assignment, parseAssignment, parseOsReference } from "./env.js";
import { assertSafeRunName } from "./startup-env.js";
import type { BrokeredAssignment, PasswordAgentPort } from "./transport.js";

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The connection one brokered reference names. Mirrors the Rust core
 * (`crates/connector-host` `password_agent::broker::broker_target`): only an
 * `os://` item under `connections/<org>[/<project>]/<provider>` brokers.
 */
export interface BrokerTarget {
  providerId: string;
  connectionRef: string;
  storePath: string;
}
const plainSegment = /^[A-Za-z0-9._-]+$/;
export function brokerTarget(reference: string): BrokerTarget {
  let item: string;
  try {
    item = parseOsReference(reference).item;
  } catch {
    throw new Error(
      "Only an os:// item under connections/<org>[/<project>]/<provider> can be brokered",
    );
  }
  const segments = item.split("/");
  const [folder, ...rest] = segments;
  if (
    folder !== "connections" ||
    (rest.length !== 2 && rest.length !== 3) ||
    !segments.every(
      (segment) => plainSegment.test(segment) && !segment.startsWith("."),
    )
  )
    throw new Error(
      "Only an os:// item under connections/<org>[/<project>]/<provider> can be brokered",
    );
  return {
    providerId: rest[rest.length - 1] ?? "",
    connectionRef: `conn://${rest.join("/")}`,
    storePath: item,
  };
}
/**
 * Scope bounds mirror the shared vectors
 * (`spec/conformance/surrogate-scope.json`), enforced by the Rust core
 * before any run and by the surrogate-proxy plugin again on the wire.
 */
const brokerMethods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
function brokerBoundedPrefix(prefix: string): boolean {
  if (!prefix.startsWith("/")) return false;
  const rest = prefix.slice(1).replace(/\/$/, "");
  return (
    rest !== "" &&
    rest.split("/").every((segment) => !["", ".", ".."].includes(segment)) &&
    // No query, fragment, backslash, semicolon, whitespace or control.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the bound is the point
    !/[?#\\;\s\u0000-\u001f\u007f]/.test(prefix)
  );
}
function brokerScopeItems(
  inputs: readonly string[],
  flag: string,
): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const input of inputs) {
    const equals = input.indexOf("=");
    const name = input.slice(0, equals);
    if (equals < 1 || !namePattern.test(name))
      throw new Error(`Expected ${flag} NAME=value[,value...]`);
    const items: string[] = [];
    for (const item of input.slice(equals + 1).split(",")) {
      const trimmed = item.trim();
      if (!trimmed)
        throw new Error(`${name} cannot be brokered: ${flag} names no value`);
      if (!items.includes(trimmed)) items.push(trimmed);
    }
    if (byName.has(name))
      throw new Error(
        `${name} cannot be brokered: ${flag} is declared twice for it`,
      );
    byName.set(name, items);
  }
  return byName;
}
/**
 * The broker plan for `run --agent-proxy`: every assignment must name a
 * brokerable `os://` connections item, and `--paths`/`--methods`
 * (`NAME=/prefix[,…]`, `NAME=GET[,…]`) must bound every brokered name
 * exactly. A rejected plan injects nothing.
 */
export function brokerPlan(
  assignments: readonly Assignment[],
  paths: readonly string[],
  methods: readonly string[],
): BrokeredAssignment[] {
  const pathScopes = brokerScopeItems(paths, "--paths");
  const methodScopes = brokerScopeItems(methods, "--methods");
  const plan: BrokeredAssignment[] = [];
  for (const { name, reference } of assignments) {
    parseAssignment(`${name}=${reference}`);
    if (plan.some((entry) => entry.name === name))
      throw new Error(`${name} cannot be brokered: it is assigned twice`);
    let target: BrokerTarget;
    try {
      target = brokerTarget(reference);
    } catch {
      throw new Error(
        `${name} cannot be brokered: --agent-proxy brokers only an os:// item under connections/<org>[/<project>]/<provider>; the value was not injected`,
      );
    }
    const prefixes = pathScopes.get(name);
    if (!prefixes)
      throw new Error(
        `${name} cannot be brokered: declare what the child may reach, for example --paths ${name}=/repos/acme --methods ${name}=GET; the root is not a scope`,
      );
    const pathPrefixes: string[] = [];
    for (const prefix of prefixes) {
      if (!brokerBoundedPrefix(prefix))
        throw new Error(
          `${name} cannot be brokered: --paths entry \`${prefix}\` does not bound the surrogate: name an absolute prefix such as /repos/acme (the root, dot segments, queries and fragments are refused)`,
        );
      const bounded = prefix.replace(/\/+$/, "");
      if (!pathPrefixes.includes(bounded)) pathPrefixes.push(bounded);
    }
    const declared = methodScopes.get(name);
    if (!declared)
      throw new Error(
        `${name} cannot be brokered: --methods ${name}=GET is required beside --paths: name the verbs the surrogate may use`,
      );
    const entryMethods: string[] = [];
    for (const method of declared) {
      const upper = method.toUpperCase();
      if (!brokerMethods.has(upper))
        throw new Error(
          `${name} cannot be brokered: --methods entry \`${upper}\` is not one of ${[...brokerMethods].join(", ")}`,
        );
      if (!entryMethods.includes(upper)) entryMethods.push(upper);
    }
    plan.push({
      name,
      reference,
      providerId: target.providerId,
      connectionRef: target.connectionRef,
      methods: entryMethods,
      pathPrefixes,
    });
  }
  for (const [flag, scoped] of [
    ["--paths", pathScopes],
    ["--methods", methodScopes],
  ] as const)
    for (const name of scoped.keys())
      if (!plan.some((entry) => entry.name === name))
        throw new Error(
          `${name} cannot be brokered: ${flag} names it, but no --env assignment brokers it`,
        );
  return plan;
}
/**
 * Broker mode of `run`: validate the plan, then hand it to the host's
 * broker capability. A host without one fails closed — the values are
 * never resolved, and no inject lane runs in the broker's place.
 */
export async function runBrokered(
  port: PasswordAgentPort,
  assignments: readonly Assignment[],
  command: readonly string[],
  paths: readonly string[],
  methods: readonly string[],
): Promise<number> {
  if (!command.length)
    throw new Error(
      "Process execution is unavailable or no command was supplied",
    );
  for (const { name } of assignments) assertSafeRunName(name);
  const plan = brokerPlan(assignments, paths, methods);
  if (!port.runBrokered)
    throw new Error(
      "Brokered run (--agent-proxy) is unavailable in this CLI; nothing was injected. Use the native opensesame CLI with the surrogate-proxy plugin.",
    );
  return port.runBrokered(plan, command);
}
