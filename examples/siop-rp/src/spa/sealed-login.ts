/**
 * The single-page relying party's login, kept sealed (ADR 0149).
 *
 * The redirect to the OP is a full navigation, so the login has to outlive
 * this document: it goes in the tab's `sessionStorage`, but never in the
 * clear. `@opensesame/browser-at-rest` seals each value under a
 * non-extractable key this origin keeps in IndexedDB, bound to the store and
 * the name, so a copy of the storage (a profile on disk, a backup, a script on
 * another origin) holds nothing usable.
 *
 * Two values, one login at a time. A tab signs in once, so there is one slot,
 * not a table: starting again replaces the login the tab was waiting on, which
 * is also what bounds it. The second value is the *binding*: the secret of the
 * tab that started the login, kept beside it and handed back at completion. A
 * response planted in another tab arrives where neither is stored.
 *
 * Where the origin can keep no key, a value would live in memory and be lost
 * by the redirect. Sign-in is refused up front instead (`SealedLoginSlot.kept`
 * says which happened), never written in the clear.
 */
import {
  type SealedStorage,
  type StorageLike,
  sealedStorage,
} from "@opensesame/browser-at-rest";
import {
  type PendingSiopLogin,
  type SiopLoginStore,
  readLogin,
} from "@opensesame/siop-v2";

const SCOPE = "siop-rp-spa";
const LOGIN = "login";
const BINDING = "binding";

type Slot = { state: string; login: PendingSiopLogin };

function readSlot(raw: string | null): Slot | undefined {
  if (raw === null) return undefined;
  const split = raw.indexOf("\n");
  if (split < 1) return undefined;
  const login = readLogin(raw.slice(split + 1));
  return login === undefined
    ? undefined
    : { state: raw.slice(0, split), login };
}

export class SealedLoginSlot implements SiopLoginStore {
  readonly #sealed: SealedStorage;
  #kept = true;

  constructor(storage: StorageLike) {
    this.#sealed = sealedStorage(storage, SCOPE);
  }

  /** False when the last `put` could not be sealed into the tab's storage. */
  get kept(): boolean {
    return this.#kept;
  }

  async put(state: string, login: PendingSiopLogin): Promise<boolean> {
    const placed = await this.#sealed.set(
      LOGIN,
      `${state}\n${JSON.stringify(login)}`,
    );
    this.#kept = placed === "stored";
    if (!this.#kept) this.#sealed.remove(LOGIN);
    // Not a capacity refusal: the caller reads `kept` and says why.
    return true;
  }

  async take(state: string): Promise<PendingSiopLogin | undefined> {
    const held = readSlot(await this.#sealed.get(LOGIN));
    // A response for some other state leaves this tab's login alone.
    if (held === undefined || held.state !== state) return undefined;
    // `take` removes before it resolves, so a second caller gets nothing.
    const taken = readSlot(await this.#sealed.take(LOGIN));
    return taken?.state === state ? taken.login : undefined;
  }

  /** Keep this tab's half of the login. Resolves true when it was sealed. */
  async bind(binding: string): Promise<boolean> {
    return (await this.#sealed.set(BINDING, binding)) === "stored";
  }

  /** This tab's binding, or empty when it has none. */
  async binding(): Promise<string> {
    return (await this.#sealed.get(BINDING)) ?? "";
  }

  /** Forget this tab's login and binding. */
  release(): void {
    this.#sealed.remove(LOGIN);
    this.#sealed.remove(BINDING);
  }
}
