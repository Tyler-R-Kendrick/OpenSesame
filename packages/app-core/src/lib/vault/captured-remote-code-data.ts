/** Original remote send/verify evidence DATA; never completed-factor, owner or REAL authority. */
import type { CodeChannel } from "@opensesame/vault-core";
import { z } from "zod";
import { host } from "../../host.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import type { SentCode } from "./remote-code.js";

const actualHost = host;
const acknowledged = z.object({
  ok: z.literal(true),
  channel: z.enum(["email", "sms"]),
  to: z.string().min(1).max(512),
});
const sent = acknowledged.extend({
  challengeId: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  expiresAt: z.string().max(64).datetime(),
});
function unavailable(): never {
  throw new Error("Original remote code authentication is unavailable.");
}
/** Drain this accepted response with its original stream methods and bounded bytes. */
async function readAcceptedCodeResponse(response: Response, check: () => void) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    const read = reader.read;
    const cancel = reader.cancel;
    const release = reader.releaseLock;
    let complete = false;
    try {
      for (;;) {
        check();
        if (
          reader.read !== read ||
          reader.cancel !== cancel ||
          reader.releaseLock !== release
        )
          unavailable();
        const chunk = await read.call(reader);
        check();
        if (chunk.done) {
          complete = true;
          break;
        }
        total += chunk.value.length;
        if (total > 16384) unavailable();
        chunks.push(chunk.value.slice());
      }
    } finally {
      try {
        if (!complete) await cancel.call(reader);
      } finally {
        release.call(reader);
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  check();
  return { ok: response.ok, status: response.status, text };
}
class OriginalRemoteCodeData {
  readonly #owner: ReturnType<typeof actualHost>;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #accessToken: string;
  readonly #original: () => void;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #sending = false;
  #verifying = false;
  #sends = 0;
  #attempts = 0;
  #challenge: Readonly<SentCode> | undefined;
  #draining: Promise<void> | undefined;
  constructor(
    owner: ReturnType<typeof actualHost>,
    actualFetch: typeof fetch,
    base: string,
    accessToken: string,
    original: () => void,
  ) {
    this.#owner = owner;
    this.#fetch = actualFetch;
    this.#base = base;
    this.#accessToken = accessToken;
    this.#original = original;
    Object.freeze(this);
  }
  check = (): void => {
    this.#original();
    if (
      this.#closed ||
      actualHost() !== this.#owner ||
      globalThis.fetch !== this.#fetch ||
      this.#controller.signal.aborted
    )
      unavailable();
  };
  #run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    const result = work();
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#pending.add(settled);
    void settled.then(() => this.#pending.delete(settled));
    return result;
  }
  async #request(path: "send" | "verify", body: string) {
    this.check();
    const timer = setTimeout(() => this.#controller.abort(), 8000);
    try {
      const actualFetch = this.#fetch;
      const response = await actualFetch(`${this.#base}/v1/mfa/code/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          "content-type": "application/json",
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        body,
        signal: this.#controller.signal,
      });
      return await readAcceptedCodeResponse(response, this.check);
    } finally {
      clearTimeout(timer);
    }
  }
  send = (channel: CodeChannel, to: string) =>
    this.#run(async () => {
      if (
        this.#sending ||
        this.#verifying ||
        this.#sends >= 3 ||
        !["email", "sms"].includes(channel) ||
        !to ||
        to.length > 512
      )
        unavailable();
      this.#sending = true;
      this.#challenge = undefined;
      this.#sends++;
      try {
        const response = await this.#request(
          "send",
          JSON.stringify({ channel, to }),
        );
        this.check();
        if (!response.ok) unavailable();
        assertUnambiguousJson(response.text, 16384);
        const parsed = sent.parse(JSON.parse(response.text));
        if (parsed.channel !== channel) unavailable();
        const expires = Date.parse(parsed.expiresAt);
        if (expires <= Date.now() || expires > Date.now() + 600000)
          unavailable();
        this.#challenge = Object.freeze({
          challengeId: parsed.challengeId,
          to: parsed.to,
          expiresAt: parsed.expiresAt,
          channel,
        });
        this.#attempts = 0;
        return this.#challenge;
      } finally {
        this.#sending = false;
      }
    });
  verify = (code: string) =>
    this.#run(async () => {
      const selected = this.#challenge;
      if (
        this.#sending ||
        this.#verifying ||
        !selected ||
        this.#attempts >= 5 ||
        !/^\d{6}$/u.test(code) ||
        Date.parse(selected.expiresAt) <= Date.now()
      )
        unavailable();
      this.#verifying = true;
      this.#attempts++;
      try {
        const response = await this.#request(
          "verify",
          JSON.stringify({ challengeId: selected.challengeId, code }),
        );
        this.check();
        if (this.#challenge !== selected) unavailable();
        if (!response.ok) unavailable();
        assertUnambiguousJson(response.text, 16384);
        const accepted = acknowledged.parse(JSON.parse(response.text));
        if (
          accepted.channel !== selected.channel ||
          accepted.to !== selected.to
        )
          unavailable();
        // Actual service acknowledgement spends only this retained challenge. No local owner verdict.
        this.#challenge = undefined;
      } finally {
        this.#verifying = false;
      }
    });
  close = (): Promise<void> => {
    this.#closed = true;
    this.#challenge = undefined;
    this.#controller.abort();
    this.#draining ??= (async () => {
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    })();
    return this.#draining;
  };
}
/** Actual Identity module supplies its lexical bearer/session check; no browser cookie fallback. */
export function captureRemoteIdentityCodeData(
  base: string,
  accessToken: string,
  issuerOrigin: string,
  original: () => void,
) {
  const owner = actualHost();
  const actualFetch = globalThis.fetch;
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== issuerOrigin ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost")) ||
    !z.function().safeParse(actualFetch).success ||
    !accessToken ||
    accessToken.length > 16384
  )
    unavailable();
  return new OriginalRemoteCodeData(
    owner,
    actualFetch,
    base,
    accessToken,
    original,
  );
}
