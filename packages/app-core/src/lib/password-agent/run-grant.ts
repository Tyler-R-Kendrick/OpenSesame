import { z } from "zod";
import { type Assignment, parseAssignment } from "./env.js";
import { durationSeconds } from "./lease.js";

/**
 * A reusable, human-approved grant for one exact `run` assignment set
 * (ADR 0205 decision 4). Until a run presents a grant, approval stays
 * per-run; a grant never widens beyond the names, references, and broker
 * scopes it was issued for.
 */
export interface RunGrantBinding {
  capability: "run";
  /** Canonical `NAME=reference` entries, sorted, duplicates refused. */
  assignments: string[];
  mounts: string[];
  agentProxy: boolean;
  /** Canonical `NAME=/prefix[,/prefix...]` entries (broker mode only). */
  paths: string[];
  /** Canonical `NAME=GET[,POST...]` entries (broker mode only). */
  methods: string[];
}

export interface RunGrantRecord extends RunGrantBinding {
  id: string;
  principal: string;
  createdAt: number;
  expiresAt: number;
  useBudget: number;
  usesRemaining: number;
  revoked: boolean;
}

export interface RunGrantStorePort {
  principal(): Promise<string>;
  insert(grant: RunGrantRecord): Promise<void>;
  get(id: string): Promise<RunGrantRecord>;
  /** Must match every bound field and atomically decrement once in a durable transaction. */
  claim(
    id: string,
    binding: RunGrantBinding,
    principal: string,
    now: number,
  ): Promise<RunGrantRecord>;
  revoke(id: string, principal: string, now: number): Promise<RunGrantRecord>;
}

export interface RunGrantInput {
  assignments: readonly Assignment[];
  mounts?: readonly Assignment[] | undefined;
  agentProxy?: boolean | undefined;
  paths?: readonly string[] | undefined;
  methods?: readonly string[] | undefined;
}

const denial =
  "Run grant is invalid, expired, revoked, exhausted, or mismatched";

function canonicalAssignments(
  entries: readonly Assignment[],
  lane: string,
): string[] {
  const rendered = entries.map((entry) => {
    const parsed = parseAssignment(`${entry.name}=${entry.reference}`);
    return `${parsed.name}=${parsed.reference}`;
  });
  const names = rendered.map((entry) => entry.slice(0, entry.indexOf("=")));
  if (new Set(names).size !== names.length)
    throw new Error(`Run grant ${lane} names must be unique`);
  return [...rendered].sort();
}

function canonicalScopes(
  entries: readonly string[],
  kind: "paths" | "methods",
): string[] {
  const byName = new Map<string, string>();
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    const name = entry.slice(0, equals);
    const raw = entry.slice(equals + 1);
    if (equals < 1 || !raw || /[\r\n\0]/.test(entry))
      throw new Error(`Run grant --${kind} requires NAME=value entries`);
    if (byName.has(name))
      throw new Error(`Run grant --${kind} names must be unique`);
    const values = raw
      .split(",")
      .map((value) =>
        kind === "methods" ? value.trim().toUpperCase() : value.trim(),
      )
      .filter(Boolean)
      .sort();
    if (!values.length || new Set(values).size !== values.length)
      throw new Error(`Run grant --${kind} values must be unique and named`);
    byName.set(name, `${name}=${values.join(",")}`);
  }
  return [...byName.values()].sort();
}

/** The exact binding a grant is issued for and a run must present. */
export function describeRunGrant(input: RunGrantInput): RunGrantBinding {
  const agentProxy = Boolean(input.agentProxy);
  const assignments = canonicalAssignments(input.assignments, "--env");
  const mounts = canonicalAssignments(input.mounts ?? [], "--mount");
  if (!assignments.length && !mounts.length)
    throw new Error("Run grant requires at least one --env or --mount entry");
  const envNames = new Set(
    assignments.map((entry) => entry.slice(0, entry.indexOf("="))),
  );
  if (mounts.some((entry) => envNames.has(entry.slice(0, entry.indexOf("=")))))
    throw new Error("A name cannot be both an env value and a mount.");
  if (agentProxy && mounts.length)
    throw new Error("--agent-proxy cannot be used with --mount.");
  const paths = canonicalScopes(input.paths ?? [], "paths");
  const methods = canonicalScopes(input.methods ?? [], "methods");
  if (!agentProxy && (paths.length || methods.length))
    throw new Error("--paths and --methods require --agent-proxy.");
  return { capability: "run", assignments, mounts, agentProxy, paths, methods };
}

const bindingSchema = z.object({
  capability: z.literal("run"),
  assignments: z.array(z.string().min(3)).max(64),
  mounts: z.array(z.string().min(3)).max(64),
  agentProxy: z.boolean(),
  paths: z.array(z.string().min(3)).max(64),
  methods: z.array(z.string().min(3)).max(64),
});
const runGrantRecordSchema = bindingSchema.extend({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\r\n\0]+$/),
  principal: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\r\n\0]+$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  useBudget: z.number().int().min(1).max(10),
  usesRemaining: z.number().int().min(0).max(10),
  revoked: z.boolean(),
});

export function validateRunGrantBinding(binding: RunGrantBinding): void {
  bindingSchema.parse(binding);
  // Re-canonicalization must be a fixed point: a persisted binding that is
  // not already canonical was not issued by the grant ceremony.
  const canonical = describeRunGrant({
    assignments: binding.assignments.map(parseAssignment),
    mounts: binding.mounts.map(parseAssignment),
    agentProxy: binding.agentProxy,
    paths: binding.paths,
    methods: binding.methods,
  });
  if (!sameRunGrantBinding(canonical, binding))
    throw new Error("Run grant binding is not canonical");
}

export function sameRunGrantBinding(
  left: RunGrantBinding,
  right: RunGrantBinding,
): boolean {
  const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    left.capability === right.capability &&
    left.agentProxy === right.agentProxy &&
    sameList(left.assignments, right.assignments) &&
    sameList(left.mounts, right.mounts) &&
    sameList(left.paths, right.paths) &&
    sameList(left.methods, right.methods)
  );
}

export interface RunGrantIssue {
  id: string;
  principal: string;
  binding: RunGrantBinding;
  now: number;
  expiresIn?: string;
  uses?: number;
}

export function createRunGrant(options: RunGrantIssue): RunGrantRecord {
  const uses = options.uses ?? 1;
  const ttl = durationSeconds(options.expiresIn ?? "10m");
  if (!options.id || !options.principal || !Number.isSafeInteger(options.now))
    throw new Error("Invalid run grant");
  if (!Number.isInteger(uses) || uses < 1 || uses > 10)
    throw new Error("Run grant uses must be between 1 and 10");
  validateRunGrantBinding(options.binding);
  return runGrantRecordSchema.parse({
    ...options.binding,
    id: options.id,
    principal: options.principal,
    createdAt: options.now,
    expiresAt: options.now + ttl * 1000,
    useBudget: uses,
    usesRemaining: uses,
    revoked: false,
  });
}

export function authorizeRunGrant(
  grant: RunGrantRecord,
  binding: RunGrantBinding,
  principal: string,
  now: number,
): RunGrantRecord {
  runGrantRecordSchema.parse(grant);
  validateRunGrantBinding(binding);
  validateRunGrantBinding(grant);
  if (
    !Number.isSafeInteger(now) ||
    grant.createdAt > now ||
    grant.expiresAt <= grant.createdAt ||
    grant.expiresAt - grant.createdAt > 3_600_000 ||
    grant.usesRemaining > grant.useBudget
  )
    throw new Error(denial);
  if (
    grant.principal !== principal ||
    !sameRunGrantBinding(grant, binding) ||
    grant.revoked ||
    grant.expiresAt <= now ||
    grant.usesRemaining < 1
  )
    throw new Error(denial);
  return grant;
}

/** Call inside the store's transaction; never implement read-then-write claims outside it. */
export function claimRunGrant(
  grant: RunGrantRecord,
  binding: RunGrantBinding,
  principal: string,
  now: number,
): RunGrantRecord {
  authorizeRunGrant(grant, binding, principal, now);
  return { ...grant, usesRemaining: grant.usesRemaining - 1 };
}
