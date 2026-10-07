/**
 * The runner's vault: the credentials a person's own browser holds for the
 * origins it drives, and the candidate a rotation generates (ADR 0076 §1, §3).
 *
 * In the local-runner model the party that fills a field is the party that
 * holds the vault, so the Host's `fill_credential` names a *reference* and
 * this resolves it. Nothing here is returned to the Host, to the page's
 * script world beyond the one field being written, or to a log; every record
 * rests sealed (`store.ts`, ADR 0149) and is bound to its own name.
 *
 * Two references exist on the wire. `current_password` is the entry for the
 * run's origin. `candidate:<id>` is a candidate this runner generated *for this
 * run and this origin*: a handle from another run, or one that names another
 * origin, resolves to nothing, so a step cannot walk a credential to a site it
 * was not made for.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type BackupStore,
  type RecoveryRecipient,
  backUp,
  importRecipient,
} from "./backup";
import { sha256Hex } from "./bytes";
import type { OriginalOwner } from "./original-owner";
import { generatePassword } from "./password";
import type { SealedKv } from "./store";

/** How the runner proves a credential works by using it (`verify_login`). */
export interface LoginProfile {
  url: string;
  usernameSelector?: string;
  passwordSelector: string;
  submitSelector: string;
  /** Present only once signed in. */
  signedInSelector: string;
  /** Present only when the site refuses the credential. */
  rejectedSelector?: string;
}

export interface VaultEntry {
  origin: string;
  username: string;
  password: string;
  /** The value before the last promotion: kept until the next one (ADR 0076 §3.5). */
  previous?: string;
  login?: LoginProfile;
  updatedAt: number;
}

export type CandidateState = "generated" | "sealed" | "promoted";

interface CandidateRecord {
  handle: string;
  origin: string;
  runId: string;
  value: string;
  state: CandidateState;
  createdAt: number;
}

/** What a held candidate is, without its value. */
export interface CandidateSummary {
  handle: string;
  origin: string;
  state: CandidateState;
  createdAt: number;
}

export interface RunContext {
  runId: string;
  origin: string;
}

export const CURRENT_PASSWORD = "current_password";
const HANDLE = /^candidate:[A-Za-z0-9-]{8,64}$/;
/** Promoted candidates kept beyond this many are forgotten, oldest first. */
const KEEP_PROMOTED = 8;

function hasText(value: BoundaryValue): value is string {
  return isString(value) && value.length > 0;
}

function decodeProfile(value: BoundaryValue): LoginProfile | undefined {
  if (!isJsonObject(value)) return undefined;
  const { url, usernameSelector, passwordSelector, submitSelector } = value;
  const { signedInSelector, rejectedSelector } = value;
  if (
    !hasText(url) ||
    !hasText(passwordSelector) ||
    !hasText(submitSelector) ||
    !hasText(signedInSelector)
  ) {
    return undefined;
  }
  const profile: LoginProfile = {
    url,
    passwordSelector,
    submitSelector,
    signedInSelector,
  };
  if (hasText(usernameSelector)) profile.usernameSelector = usernameSelector;
  if (hasText(rejectedSelector)) profile.rejectedSelector = rejectedSelector;
  return profile;
}

function decodeEntry(value: BoundaryValue): VaultEntry | null {
  if (!isJsonObject(value)) return null;
  const { origin, username, password, previous, login, updatedAt } = value;
  if (!hasText(origin) || !isString(username) || !hasText(password)) {
    return null;
  }
  const entry: VaultEntry = {
    origin,
    username,
    password,
    updatedAt: isNumber(updatedAt) ? updatedAt : 0,
  };
  if (hasText(previous)) entry.previous = previous;
  const profile = decodeProfile(login);
  if (profile) entry.login = profile;
  return entry;
}

const STATES: readonly CandidateState[] = ["generated", "sealed", "promoted"];

function candidateState(value: BoundaryValue): CandidateState | null {
  return STATES.find((state) => state === value) ?? null;
}

function decodeCandidate(value: BoundaryValue): CandidateRecord | null {
  if (!isJsonObject(value)) return null;
  const { handle, origin, runId, value: secret, createdAt } = value;
  const state = candidateState(value.state);
  if (
    !hasText(handle) ||
    !HANDLE.test(handle) ||
    !hasText(origin) ||
    !hasText(runId) ||
    !hasText(secret) ||
    state === null ||
    !isNumber(createdAt)
  ) {
    return null;
  }
  return { handle, origin, runId, value: secret, state, createdAt };
}

/** A public key as stored: only the members a recovery recipient has. */
function decodeJwk(value: BoundaryValue): JsonWebKey | null {
  if (!isJsonObject(value)) return null;
  const jwk: JsonWebKey = {};
  for (const member of ["kty", "n", "e", "alg"] as const) {
    const held = value[member];
    if (isString(held)) jwk[member] = held;
  }
  return jwk;
}

export interface VaultOptions {
  now?: () => number;
  random?: (bytes: Uint8Array) => Uint8Array;
}

export class RunnerVault {
  private readonly now: () => number;
  private readonly random: (bytes: Uint8Array) => Uint8Array;

  constructor(
    private readonly kv: SealedKv,
    options: VaultOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((bytes) => crypto.getRandomValues(bytes));
  }

  withAuthority(owner: OriginalOwner): RunnerVault {
    return new RunnerVault(this.kv.withAuthority(owner), {
      now: this.now,
      random: this.random,
    });
  }

  // --- entries -----------------------------------------------------------

  private async entryName(origin: string): Promise<string> {
    return `vault.${(await sha256Hex(origin)).slice(0, 32)}`;
  }

  async getEntry(origin: string): Promise<VaultEntry | null> {
    const entry = decodeEntry(
      await this.kv.getJson(await this.entryName(origin)),
    );
    return entry?.origin === origin ? entry : null;
  }

  async putEntry(entry: Omit<VaultEntry, "updatedAt">): Promise<void> {
    const kept = await this.getEntry(entry.origin);
    const next: VaultEntry = { ...entry, updatedAt: this.now() };
    if (kept) {
      // The rollback credential lives until the next promotion (ADR 0076
      // §3.5): re-saving the same password must not erase it.
      if (kept.password !== entry.password) next.previous = kept.password;
      else if (entry.previous === undefined && kept.previous !== undefined) {
        next.previous = kept.previous;
      }
    }
    await this.kv.setJson(await this.entryName(entry.origin), next);
  }

  async removeEntry(origin: string): Promise<void> {
    await this.kv.remove(await this.entryName(origin));
  }

  /** The origins a credential is held for. Names only. */
  async origins(): Promise<string[]> {
    const found: string[] = [];
    for (const name of await this.kv.names("vault.")) {
      const entry = decodeEntry(await this.kv.getJson(name));
      if (entry) found.push(entry.origin);
    }
    return found.sort();
  }

  // --- recovery recipient --------------------------------------------------

  async recipient(): Promise<RecoveryRecipient | null> {
    const stored = await this.kv.getJson("recovery.recipient");
    if (!isJsonObject(stored)) return null;
    const jwk = decodeJwk(stored.jwk);
    if (!jwk) return null;
    // Re-imported on every read: what is used is what validates, not what was stored.
    const recipient = await importRecipient(jwk);
    return recipient && recipient.kid === stored.kid ? recipient : null;
  }

  /** Pin the recipient backups are addressed to. `false` when it is not a usable key. */
  async setRecipient(jwk: JsonWebKey): Promise<RecoveryRecipient | null> {
    const recipient = await importRecipient(jwk);
    if (recipient) await this.kv.setJson("recovery.recipient", recipient);
    return recipient;
  }

  // --- candidates ----------------------------------------------------------

  private candidateName(handle: string): string | null {
    return HANDLE.test(handle)
      ? `cand.${handle.slice("candidate:".length)}`
      : null;
  }

  private async candidate(handle: string): Promise<CandidateRecord | null> {
    const name = this.candidateName(handle);
    if (!name) return null;
    const record = decodeCandidate(await this.kv.getJson(name));
    return record?.handle === handle ? record : null;
  }

  private async saveCandidate(record: CandidateRecord): Promise<void> {
    const name = this.candidateName(record.handle);
    if (!name) throw new Error("candidate_handle");
    await this.kv.setJson(name, record);
  }

  /** Generate a candidate for this run. The value goes to the sealed store and nowhere else. */
  async generate(ctx: RunContext, handle: string): Promise<boolean> {
    if (!this.candidateName(handle) || (await this.candidate(handle)))
      return false;
    await this.saveCandidate({
      handle,
      origin: ctx.origin,
      runId: ctx.runId,
      value: generatePassword(this.random),
      state: "generated",
      createdAt: this.now(),
    });
    await this.pruneOld();
    return true;
  }

  private async mine(handle: string, ctx: RunContext) {
    const record = await this.candidate(handle);
    return record && record.runId === ctx.runId && record.origin === ctx.origin
      ? record
      : null;
  }

  /**
   * The value a reference names for this run, or `null`. The only caller is
   * the step that writes it into one field; the value is never returned past it.
   */
  async resolve(reference: string, ctx: RunContext): Promise<string | null> {
    if (reference === CURRENT_PASSWORD) {
      return (await this.getEntry(ctx.origin))?.password ?? null;
    }
    return (await this.mine(reference, ctx))?.value ?? null;
  }

  /**
   * Seal the candidate and prove it is backed up. `true` only when the backup
   * recipient is set, the Host accepted the envelope and returned it unchanged.
   * The candidate stays sealed on this device either way: a candidate is only
   * ever deleted by being promoted past.
   */
  async seal(
    ctx: RunContext,
    handle: string,
    store: BackupStore | null,
  ): Promise<boolean> {
    const record = await this.mine(handle, ctx);
    if (!record || !store) return false;
    if (record.state !== "generated" && record.state !== "sealed") return false;
    const recipient = await this.recipient();
    if (!recipient) return false;
    const saved = await backUp(
      store,
      recipient,
      { handle, origin: ctx.origin },
      record.value,
    );
    if (!saved) return false;
    if (record.state === "generated") {
      await this.saveCandidate({ ...record, state: "sealed" });
    }
    return true;
  }

  /** Make a sealed candidate the live credential. Refused until its backup was proven. */
  async promote(ctx: RunContext, handle: string): Promise<boolean> {
    const record = await this.mine(handle, ctx);
    const entry = await this.getEntry(ctx.origin);
    if (!record || !entry) return false;
    if (record.state === "generated") return false;
    if (entry.password !== record.value) {
      const next: Omit<VaultEntry, "updatedAt"> = {
        origin: entry.origin,
        username: entry.username,
        password: record.value,
      };
      if (entry.login) next.login = entry.login;
      await this.putEntry(next);
    }
    if (record.state !== "promoted") {
      await this.saveCandidate({ ...record, state: "promoted" });
    }
    return true;
  }

  /** Every value this run knows, so a page read can be scrubbed of them. */
  async secrets(ctx: RunContext): Promise<string[]> {
    const entry = await this.getEntry(ctx.origin);
    const held = [entry?.password, entry?.previous].filter(hasText);
    for (const name of await this.kv.names("cand.")) {
      const record = decodeCandidate(await this.kv.getJson(name));
      if (record && record.origin === ctx.origin) held.push(record.value);
    }
    return held;
  }

  async candidates(): Promise<CandidateSummary[]> {
    const rows: CandidateSummary[] = [];
    for (const name of await this.kv.names("cand.")) {
      const record = decodeCandidate(await this.kv.getJson(name));
      if (record) {
        rows.push({
          handle: record.handle,
          origin: record.origin,
          state: record.state,
          createdAt: record.createdAt,
        });
      }
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Forget promoted candidates beyond the newest few. Never one that is not promoted. */
  private async pruneOld(): Promise<void> {
    const promoted = (await this.candidates()).filter(
      (c) => c.state === "promoted",
    );
    for (const old of promoted.slice(
      0,
      Math.max(0, promoted.length - KEEP_PROMOTED),
    )) {
      const name = this.candidateName(old.handle);
      if (name) await this.kv.remove(name);
    }
  }
}
