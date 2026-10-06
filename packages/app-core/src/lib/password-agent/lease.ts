import { z } from "zod";
import { type Binding, referenceLocation } from "./request.js";
import { type PasswordAgentPort, json } from "./transport.js";
export interface ResourceVersion {
  id: string;
  version: number;
}
export interface LeaseRecord extends Binding {
  id: string;
  principal: string;
  itemId: string;
  itemVersion: number;
  createdAt: number;
  expiresAt: number;
  useBudget: number;
  usesRemaining: number;
  revoked: boolean;
}
export interface LeaseStorePort {
  principal(): Promise<string>;
  insert(lease: LeaseRecord): Promise<void>;
  get(id: string): Promise<LeaseRecord>;
  /** Must match every bound field and atomically decrement once in a durable transaction. */
  claim(
    id: string,
    binding: Binding,
    resource: ResourceVersion,
    principal: string,
    now: number,
  ): Promise<LeaseRecord>;
  revoke(id: string, principal: string, now: number): Promise<LeaseRecord>;
}
export interface LeaseGrant {
  id: string;
  principal: string;
  binding: Binding;
  resource: ResourceVersion;
  now: number;
  expiresIn?: string;
  uses?: number;
}
export interface LeaseResolverPorts {
  store: LeaseStorePort;
  inspect(reference: string): Promise<ResourceVersion>;
  read(reference: string): Promise<string>;
  now(): number;
}
const bindingSchema = z.object({
  capability: z.literal("request"),
  method: z.literal("GET"),
  reference: z.string(),
  destination: z.url(),
  destinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  header: z.enum(["Authorization", "X-API-Key"]),
  prefix: z
    .string()
    .max(64)
    .regex(/^[^\r\n\0]*$/),
});
const leaseRecordSchema = bindingSchema.extend({
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
  itemId: z.string().regex(/^[a-z0-9]{26}$/),
  itemVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  useBudget: z.number().int().min(1).max(10),
  usesRemaining: z.number().int().min(0).max(10),
  revoked: z.boolean(),
});
export function validateLeaseBinding(binding: Binding): void {
  bindingSchema.parse(binding);
  referenceLocation(binding.reference);
  const url = new URL(binding.destination);
  if (url.protocol !== "https:" || binding.destination !== url.origin)
    throw new Error("Invalid lease destination");
}
const denial =
  "Lease is invalid, expired, revoked, exhausted, stale, or mismatched";
export function durationSeconds(value: string): number {
  const match = /^([1-9]\d*)([smh])$/.exec(value);
  if (!match)
    throw new Error("Lease lifetime must be a duration such as 10m or 1h");
  const units = new Map([
    ["s", 1],
    ["m", 60],
    ["h", 3600],
  ]);
  const seconds = Number(match[1]) * (units.get(match[2] ?? "") ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds > 3600)
    throw new Error("Lease lifetime cannot exceed 60 minutes");
  return seconds;
}
function validResource(resource: ResourceVersion): boolean {
  return (
    /^[a-z0-9]{26}$/.test(resource.id) &&
    Number.isSafeInteger(resource.version) &&
    resource.version >= 1
  );
}
export function createLease(options: LeaseGrant): LeaseRecord {
  const uses = options.uses ?? 1;
  const ttl = durationSeconds(options.expiresIn ?? "10m");
  if (
    !options.id ||
    !options.principal ||
    !Number.isSafeInteger(options.now) ||
    !validResource(options.resource)
  )
    throw new Error("Invalid lease grant");
  if (!Number.isInteger(uses) || uses < 1 || uses > 10)
    throw new Error("Lease uses must be between 1 and 10");
  validateLeaseBinding(options.binding);
  return leaseRecordSchema.parse({
    ...options.binding,
    id: options.id,
    principal: options.principal,
    itemId: options.resource.id,
    itemVersion: options.resource.version,
    createdAt: options.now,
    expiresAt: options.now + ttl * 1000,
    useBudget: uses,
    usesRemaining: uses,
    revoked: false,
  });
}
export function sameBinding(lease: Binding, binding: Binding): boolean {
  return (
    lease.capability === binding.capability &&
    lease.method === binding.method &&
    lease.reference === binding.reference &&
    lease.destination === binding.destination &&
    lease.destinationFingerprint === binding.destinationFingerprint &&
    lease.header === binding.header &&
    lease.prefix === binding.prefix
  );
}
export function authorizeLease(
  lease: LeaseRecord,
  binding: Binding,
  principal: string,
  now: number,
): LeaseRecord {
  leaseRecordSchema.parse(lease);
  validateLeaseBinding(binding);
  if (
    !Number.isSafeInteger(now) ||
    lease.createdAt > now ||
    lease.expiresAt <= lease.createdAt ||
    lease.expiresAt - lease.createdAt > 3_600_000 ||
    lease.usesRemaining > lease.useBudget
  )
    throw new Error(denial);
  if (
    lease.principal !== principal ||
    !sameBinding(lease, binding) ||
    lease.revoked ||
    lease.expiresAt <= now ||
    lease.usesRemaining < 1
  )
    throw new Error(denial);
  return lease;
}
/** Call inside the store's transaction; never implement read-then-write claims outside it. */
export function claimLease(
  lease: LeaseRecord,
  binding: Binding,
  resource: ResourceVersion,
  principal: string,
  now: number,
): LeaseRecord {
  authorizeLease(lease, binding, principal, now);
  if (lease.itemId !== resource.id || lease.itemVersion !== resource.version)
    throw new Error(denial);
  return { ...lease, usesRemaining: lease.usesRemaining - 1 };
}
const summariesSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9]{26}$/),
    title: z.string(),
    version: z.number().int().positive(),
  }),
);
export async function inspectReference(
  port: PasswordAgentPort,
  reference: string,
): Promise<ResourceVersion> {
  const location = referenceLocation(reference);
  try {
    const summaries = summariesSchema.parse(
      await json(port, [
        "item",
        "list",
        "--vault",
        location.vault,
        "--format",
        "json",
      ]),
    );
    const matches = summaries.filter(
      (item) => item.id === location.item || item.title === location.item,
    );
    const selected = matches[0];
    if (!selected || matches.length !== 1) throw new Error("ambiguous");
    return { id: selected.id, version: selected.version };
  } catch {
    throw new Error(
      "Could not inspect exactly one credential version (details suppressed)",
    );
  }
}
async function claimWith(
  id: string,
  binding: Binding,
  ports: LeaseResolverPorts,
): Promise<ResourceVersion> {
  try {
    const before = await ports.inspect(binding.reference);
    if (!validResource(before)) throw new Error(denial);
    const principal = await ports.store.principal();
    await ports.store.claim(id, binding, before, principal, ports.now());
    return before;
  } catch {
    throw new Error(
      "Lease claim denied or credential version unavailable (details suppressed)",
    );
  }
}
export function resolverWith(
  id: string,
  binding: Binding,
  ports: LeaseResolverPorts,
): (reference: string) => Promise<string> {
  return async (reference) => {
    if (reference !== binding.reference)
      throw new Error("Lease does not match the requested credential");
    const before = await claimWith(id, binding, ports);
    try {
      const value = await ports.read(reference);
      const after = await ports.inspect(reference);
      if (after.id !== before.id || after.version !== before.version)
        throw new Error("changed");
      return value;
    } catch {
      throw new Error(
        "Leased credential resolution failed or changed; the use was consumed and nothing was sent (details suppressed)",
      );
    }
  };
}
