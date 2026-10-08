import { z } from "zod";
import type { RetiredCredentialTrap } from "../../lib/retired-credentials/index.js";
import {
  type ManagementOperation,
  managementRequest,
} from "./management-wire.js";

export const SECURITY_PORT = "opensesame.security";
export const securityRequest = z.discriminatedUnion("op", [
  managementRequest,
  z
    .object({
      id: z.number().int().nonnegative(),
      op: z.literal("unlock"),
      password: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({ id: z.number().int().nonnegative(), op: z.literal("lock") })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      op: z.literal("authorize"),
      permit: z.string().max(64).optional(),
    })
    .strict(),
]);
export const securityReply = z.object({
  id: z.number().int().nonnegative(),
  realm: z.enum(["locked", "real", "synthetic"]),
  permit: z.string().optional(),
  trap: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      response: z.literal("synthetic_decoy"),
    })
    .optional(),
  error: z.string().optional(),
  resultJson: z.string().max(32768).optional(),
});
export type SecurityRequest = z.infer<typeof securityRequest>;
export type SecurityReply = z.infer<typeof securityReply>;
export type Admission =
  | { realm: "real" }
  | { realm: "synthetic"; trap: RetiredCredentialTrap };
export type BrokerPorts = {
  revision(): Promise<string | null>;
  classify(password: string): Promise<Admission>;
  now(): number;
  manage?(
    operation: ManagementOperation,
    password: string,
    check: () => void,
  ): Promise<string>;
};
type PortIdentity = { readonly id: symbol };
type Lease = {
  realm: "real" | "synthetic";
  revision: string;
  until: number;
  owner: PortIdentity;
};
// Two memory-hard classifications bound the worker to 128 MiB of trap KDF work.
const MAX_WORKER_AUTHENTICATIONS = 2;
const MAX_PORT_AUTHENTICATIONS = 2;
/** Only the trusted worker mints production permits. A page's decoy flag grants nothing. */
export class ExtensionRealmBroker {
  readonly #leases = new Map<string, Lease>();
  readonly #clients = new Set<PortIdentity>();
  #protected = false;
  #authenticating = 0;
  constructor(readonly ports: BrokerPorts) {}
  async #authorize(
    owner: PortIdentity,
    request: Pick<
      Extract<SecurityRequest, { op: "authorize" }>,
      "id" | "permit"
    >,
  ): Promise<SecurityReply> {
    const lease = request.permit ? this.#leases.get(request.permit) : undefined;
    const allowed =
      (!lease || lease.owner === owner) && (await this.allows(request.permit));
    return {
      id: request.id,
      realm:
        allowed &&
        this.#clients.has(owner) &&
        (!request.permit || this.#leases.get(request.permit) === lease)
          ? "real"
          : "locked",
    };
  }
  async #manage(
    owner: PortIdentity,
    request: Extract<SecurityRequest, { op: "manage" }>,
  ): Promise<SecurityReply> {
    const refusal = "Owner management failed. Authenticate again.";
    const lease = this.#leases.get(request.permit);
    if (!lease || lease.realm !== "real" || lease.owner !== owner)
      return { id: request.id, realm: "locked", error: refusal };
    const check = () => {
      if (
        !this.#clients.has(owner) ||
        this.#leases.get(request.permit) !== lease ||
        lease.until <= this.ports.now()
      )
        throw new Error(refusal);
    };
    try {
      check();
      const authorized = await this.allows(request.permit);
      check();
      if (!authorized || !this.ports.manage || this.#authenticating)
        throw new Error(refusal);
      this.#authenticating += 1;
      try {
        const resultJson = await this.ports.manage(
          request.operation,
          request.password,
          check,
        );
        check();
        if (!(await this.allows(request.permit))) throw new Error(refusal);
        check();
        return { id: request.id, realm: "real", resultJson };
      } finally {
        this.#authenticating -= 1;
      }
    } catch {
      return {
        id: request.id,
        realm: "locked",
        error: refusal,
      };
    }
  }
  attach() {
    if (this.#clients.size >= 32)
      throw new Error("Too many security sessions.");
    const owner = { id: Symbol("security_port") };
    this.#clients.add(owner);
    let generation = 0;
    let authenticating = 0;
    const clear = () => {
      generation += 1;
      for (const [token, lease] of this.#leases)
        if (lease.owner === owner) this.#leases.delete(token);
    };
    return {
      close: () => {
        clear();
        this.#clients.delete(owner);
      },
      handle: async (
        input: z.input<typeof securityRequest>,
      ): Promise<SecurityReply> => {
        const request = securityRequest.parse(input);
        if (request.op === "authorize") return this.#authorize(owner, request);
        if (request.op === "manage") return this.#manage(owner, request);
        clear();
        const expected = generation;
        if (request.op === "lock") return { id: request.id, realm: "locked" };
        // Superseded and disconnected work retains its slot until it settles:
        // a page cannot turn cancellation or port churn into unbounded KDFs.
        if (
          !this.#clients.has(owner) ||
          authenticating >= MAX_PORT_AUTHENTICATIONS ||
          this.#authenticating >= MAX_WORKER_AUTHENTICATIONS
        )
          return { id: request.id, realm: "locked" };
        authenticating += 1;
        this.#authenticating += 1;
        try {
          const before = await this.ports.revision();
          if (!before) throw new Error("Create a protected vault first.");
          this.#protected = true;
          const admission = await this.ports.classify(request.password);
          const after = await this.ports.revision();
          if (
            !this.#clients.has(owner) ||
            expected !== generation ||
            before !== after
          )
            throw new Error("Authentication changed. Try again.");
          const permit = crypto.randomUUID();
          this.#leases.set(permit, {
            realm: admission.realm,
            revision: before,
            until: this.ports.now() + 300000,
            owner,
          });
          const reply: SecurityReply = {
            id: request.id,
            realm: admission.realm,
            permit,
          };
          if (admission.realm === "synthetic")
            reply.trap = { ...admission.trap, response: "synthetic_decoy" };
          return reply;
        } catch {
          return {
            id: request.id,
            realm: "locked",
            error: "The password did not open this vault.",
          };
        } finally {
          authenticating -= 1;
          this.#authenticating -= 1;
        }
      },
    };
  }
  /** Capture only after allows(); synchronous checks never adopt a later ticket. */
  pin(permit?: string) {
    const lease = permit ? this.#leases.get(permit) : undefined;
    const unprotected = permit === undefined && !this.#protected && !lease;
    const check = () => {
      if (unprotected) {
        if (this.#protected) throw new Error("Original runner authority ended");
        return;
      }
      if (
        !lease ||
        lease.realm !== "real" ||
        this.#leases.get(permit ?? "") !== lease ||
        !this.#clients.has(lease.owner) ||
        lease.until <= this.ports.now()
      )
        throw new Error("Original runner authority ended");
    };
    check();
    return { check };
  }
  async allows(permit?: string): Promise<boolean> {
    const revision = await this.ports.revision();
    // Existing unprotected installations retain their existing consent controls.
    if (revision === null) return !this.#protected;
    this.#protected = true;
    const lease = permit ? this.#leases.get(permit) : undefined;
    return (
      !!lease &&
      lease.realm === "real" &&
      lease.until > this.ports.now() &&
      lease.revision === revision
    );
  }
}
