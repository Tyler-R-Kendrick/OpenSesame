/** Volatile, one-use SAML POST custody; never verifies identity or writes a cache. */
import {
  SAML_POST_BYTES,
  type SamlPostArmSchema,
  SamlPostCommandSchema,
  type SamlPostRecord,
  type SamlPostReply,
} from "@opensesame/app-core/browser/saml/post-wire.js";

type Armed = Readonly<{
  ownerId: string;
  claimed: boolean;
  arm: ReturnType<typeof SamlPostArmSchema.parse>;
}>;
type Custody = Readonly<{
  ownerId: string;
  record: SamlPostRecord;
  response: string;
  approved: boolean;
}>;
export type SamlPostIngressOptions = Readonly<{
  scopeUrl: string;
  callbackScriptUrl: string;
  clients: Clients;
}>;
const CAPACITY = 4;
const READ_MS = 5000;
const CUSTODY_MS = 30000;
const FORM_BYTES = SAML_POST_BYTES * 6;

function callback(options: SamlPostIngressOptions): string {
  const scope = new URL(options.scopeUrl);
  const script = new URL(options.callbackScriptUrl);
  if (
    !scope.pathname.endsWith("/") ||
    scope.search ||
    scope.hash ||
    scope.username ||
    scope.password ||
    script.origin !== scope.origin ||
    !script.pathname.startsWith(scope.pathname) ||
    script.search ||
    script.hash ||
    script.username ||
    script.password ||
    !script.pathname.endsWith(".js")
  )
    throw new Error("Invalid release-owned SAML callback script");
  const attribute = script.href
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><title>SAML sign-in</title><p id="saml-status">Returning sign-in to the originating window…</p><script type="module" src="${attribute}"></script>`;
}
function reply(body: string, status: number, html = false): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": html
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing SAML form");
  let bytes = 0;
  let expired = false;
  const chunks: Uint8Array[] = [];
  // Cancelling the reader resolves a pending read before releaseLock, including on deadline.
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, READ_MS);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (expired) throw new Error("SAML form deadline");
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > FORM_BYTES) throw new Error("SAML form byte limit");
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
type ParsedForm = Readonly<{ nonce: string; response: string }>;
function formResponse(body: string): ParsedForm {
  const form = new URLSearchParams(body);
  const nonce = form.get("RelayState") ?? "";
  const response = form.get("SAMLResponse") ?? "";
  if (
    [...form].length !== 2 ||
    form.getAll("RelayState").length !== 1 ||
    form.getAll("SAMLResponse").length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !response ||
    response.length > Math.ceil(SAML_POST_BYTES / 3) * 4 ||
    response.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response)
  )
    throw new Error("Malformed SAML form");
  const binary = atob(response);
  if (binary.length > SAML_POST_BYTES || btoa(binary) !== response)
    throw new Error("Noncanonical SAML encoding");
  new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
  return { nonce, response };
}
class SamlPostIngress {
  readonly scope: URL;
  readonly acsUrl: string;
  readonly document: string;
  readonly arms = new Map<string, Armed>();
  readonly records = new Map<string, Custody>();
  readers = 0;
  closed = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly options: SamlPostIngressOptions) {
    this.scope = new URL(options.scopeUrl);
    this.acsUrl = new URL("auth/native-saml", this.scope).href;
    this.document = callback(options);
  }
  expire(): void {
    const now = Date.now();
    for (const [nonce, pending] of this.arms)
      if (pending.arm.expiresAt <= now) this.arms.delete(nonce);
    for (const [id, record] of this.records)
      if (record.record.expiresAt <= now) this.records.delete(id);
  }
  schedule(): void {
    clearTimeout(this.timer);
    const deadlines = [...this.arms.values()]
      .map((value) => value.arm.expiresAt)
      .concat(
        [...this.records.values()].map((value) => value.record.expiresAt),
      );
    if (deadlines.length && !this.closed)
      this.timer = setTimeout(
        () => {
          this.expire();
          this.schedule();
        },
        Math.max(1, Math.min(...deadlines) - Date.now()),
      );
  }
  async ownerExists(id: string): Promise<boolean> {
    const windows = await this.options.clients.matchAll({ type: "window" });
    const client = windows.find((window) => window.id === id);
    if (!client) return false;
    const url = new URL(client.url);
    return (
      url.origin === this.scope.origin &&
      url.pathname.startsWith(this.scope.pathname) &&
      url.href !== this.acsUrl
    );
  }
  pending(nonce: string, request: Request): Armed {
    const pending = this.arms.get(nonce);
    if (!pending || pending.claimed)
      throw new Error("SAML attempt missing or already used");
    // Origin:null is routing metadata, never identity evidence. Privacy policies can produce it.
    const origin = request.headers.get("origin");
    if (origin !== "null" && origin !== pending.arm.idpOrigin)
      throw new Error("Unexpected SAML form origin");
    const claimed = { ...pending, claimed: true };
    this.arms.set(nonce, claimed); // Atomic before owner lookup await.
    return claimed;
  }
  async receive(
    event: Pick<FetchEvent, "request" | "resultingClientId">,
  ): Promise<Response> {
    this.expire();
    if (
      this.closed ||
      !event.resultingClientId ||
      this.readers >= CAPACITY ||
      this.records.size >= CAPACITY
    )
      return reply("SAML sign-in unavailable; start a new attempt", 409);
    if (
      event.request.mode !== "navigate" ||
      event.request.destination !== "document"
    )
      return reply("SAML navigation required", 400);
    if (
      event.request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/x-www-form-urlencoded"
    )
      return reply("SAML form encoding required", 415);
    this.readers++;
    try {
      const { nonce, response } = formResponse(
        await boundedBody(event.request),
      );
      this.expire();
      const pending = this.pending(nonce, event.request);
      const alive = await this.ownerExists(pending.ownerId);
      if (
        !alive ||
        this.closed ||
        pending.arm.expiresAt <= Date.now() ||
        this.arms.get(nonce) !== pending
      )
        return reply("SAML originating window expired", 409);
      this.arms.delete(nonce);
      const record: SamlPostRecord = Object.freeze({
        nonce,
        requestId: pending.arm.requestId,
        expiresAt: Math.min(pending.arm.expiresAt, Date.now() + CUSTODY_MS),
        acsUrl: this.acsUrl,
        recordId: event.resultingClientId,
        publicKey: pending.arm.publicKey,
      });
      this.records.set(event.resultingClientId, {
        ownerId: pending.ownerId,
        record,
        response,
        approved: false,
      });
      this.schedule();
      return reply(this.document, 200, true);
    } catch {
      return reply("SAML response has no valid pending attempt", 400);
    } finally {
      this.readers--;
    }
  }
  async arm(
    id: string,
    value: ReturnType<typeof SamlPostArmSchema.parse>,
  ): Promise<SamlPostReply> {
    const now = Date.now();
    const origin = new URL(value.idpOrigin);
    if (
      origin.origin !== value.idpOrigin ||
      !["https:", "http:"].includes(origin.protocol) ||
      value.expiresAt <= now ||
      value.expiresAt > now + 300000 ||
      this.arms.has(value.nonce)
    )
      return { ok: false, reason: "denied" };
    if (this.arms.size + this.records.size >= CAPACITY)
      return { ok: false, reason: "capacity" };
    const pending: Armed = { ownerId: id, arm: value, claimed: true };
    this.arms.set(value.nonce, pending); // Reserve before lookup so cancellation can erase this exact in-flight arm.
    this.schedule();
    if (
      !(await this.ownerExists(id)) ||
      this.closed ||
      this.arms.get(value.nonce) !== pending ||
      value.expiresAt <= Date.now()
    ) {
      if (this.arms.get(value.nonce) === pending) this.arms.delete(value.nonce);
      this.schedule();
      return { ok: false, reason: "denied" };
    }
    this.arms.set(value.nonce, { ...pending, claimed: false });
    return { ok: true };
  }
  cancel(id: string, nonce: string): SamlPostReply {
    if (this.arms.get(nonce)?.ownerId === id) this.arms.delete(nonce);
    for (const [key, custody] of this.records)
      if (custody.ownerId === id && custody.record.nonce === nonce)
        this.records.delete(key);
    this.schedule();
    return { ok: true };
  }
  claim(id: string, nonce: string, recordId: string): SamlPostReply {
    const custody = this.records.get(recordId);
    if (!custody) return { ok: false, reason: "missing" };
    if (
      id !== custody.ownerId ||
      nonce !== custody.record.nonce ||
      custody.approved
    )
      return { ok: false, reason: "denied" };
    this.records.set(recordId, { ...custody, approved: true });
    return { ok: true, record: custody.record };
  }
  matchesConsumer(
    custody: Custody,
    id: string,
    command: "SAML_METADATA" | "SAML_CONSUME",
    nonce: string,
  ): boolean {
    return (
      custody.record.recordId === id &&
      (command === "SAML_METADATA" ||
        (nonce === custody.record.nonce && custody.approved))
    );
  }
  async read(
    id: string,
    command: "SAML_METADATA" | "SAML_CONSUME",
    nonce = "",
    recordId = id,
  ): Promise<SamlPostReply> {
    const custody = this.records.get(recordId);
    if (!custody) return { ok: false, reason: "missing" };
    const callbackClient = await this.options.clients.get(id);
    if (
      callbackClient?.url !== this.acsUrl ||
      this.records.get(recordId) !== custody
    )
      return { ok: false, reason: "denied" };
    if (!this.matchesConsumer(custody, id, command, nonce))
      return { ok: false, reason: "denied" };
    if (command === "SAML_CONSUME") this.records.delete(id); // Delete before asynchronous owner check or reply.
    if (
      !(await this.ownerExists(custody.ownerId)) ||
      this.closed ||
      custody.record.expiresAt <= Date.now()
    )
      return { ok: false, reason: "missing" };
    if (command === "SAML_METADATA" && this.records.get(id) !== custody)
      return { ok: false, reason: "missing" };
    return command === "SAML_METADATA"
      ? { ok: true, record: custody.record }
      : { ok: true, record: custody.record, response: custody.response };
  }
  async command(event: ExtendableMessageEvent): Promise<SamlPostReply> {
    this.expire();
    const parsed = SamlPostCommandSchema.safeParse(event.data);
    const source = event.source;
    if (this.closed || !parsed.success || !source || !("id" in source))
      return { ok: false, reason: "malformed" };
    const value = parsed.data;
    if (value.kind === "SAML_ARM") return this.arm(source.id, value);
    if (value.kind === "SAML_CANCEL")
      return this.cancel(source.id, value.nonce);
    if (value.kind === "SAML_CLAIM")
      return this.claim(source.id, value.nonce, value.recordId);
    if (value.kind === "SAML_METADATA") return this.read(source.id, value.kind);
    return this.read(source.id, value.kind, value.nonce, value.recordId);
  }
  respond(
    event: Pick<FetchEvent, "request" | "resultingClientId">,
  ): Promise<Response> | null {
    if (event.request.url !== this.acsUrl) return null;
    if (event.request.method !== "POST")
      return Promise.resolve(
        reply("Start a new SAML sign-in in the original window", 405),
      );
    return this.receive(event);
  }
  async message(event: ExtendableMessageEvent): Promise<void> {
    const parsed = SamlPostCommandSchema.safeParse(event.data);
    if (
      !parsed.success ||
      (!event.ports[0] && parsed.data.kind !== "SAML_CANCEL")
    )
      return;
    const result = await this.command(event);
    event.ports[0]?.postMessage(result);
  }
  close(): void {
    this.closed = true;
    this.arms.clear();
    this.records.clear();
    clearTimeout(this.timer);
  }
}
export function createSamlPostIngress(options: SamlPostIngressOptions) {
  return new SamlPostIngress(options);
}
