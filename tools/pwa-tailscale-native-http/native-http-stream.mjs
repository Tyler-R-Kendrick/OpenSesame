import * as z from "zod/v4/mini";
z.config({ jitless: true });

const headSchema = z.strictObject({
  status: z.number(),
  statusText: z.string(),
  url: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
});
const chunkSchema = z.strictObject({
  sequence: z.number(),
  body: z.instanceof(Uint8Array),
  eof: z.boolean(),
});
const bufferSchema = z.instanceof(ArrayBuffer);
const MAX_BODY = 4 << 20;
const MAX_CHUNK = 32 << 10;
const encoded = (value) => new TextEncoder().encode(value).byteLength;

function decodeHead(value) {
  const head = headSchema.parse(value);
  const url = new URL(head.url);
  if (
    !Number.isInteger(head.status) ||
    head.status < 200 ||
    head.status > 599 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    encoded(head.url) > 8192 ||
    encoded(head.statusText) > 32768 ||
    /[\r\n\0]/.test(head.statusText) ||
    head.headers.length > 64
  )
    throw new Error("Invalid native stream headers.");
  let size = 0;
  const headers = head.headers.map(([name, text]) => {
    size += encoded(name) + encoded(text) + 4;
    if (size > 32768 || /[\r\n\0]/.test(name + text))
      throw new Error("Invalid native stream headers.");
    return [name, text];
  });
  return {
    status: head.status,
    statusText: head.statusText,
    url: head.url,
    headers,
  };
}

/** Pull publication shares the buffered owner's IDs, tokens, capacity and deadline. */
export class NativeHTTPPull {
  constructor(owner, contracts) {
    this.owner = owner;
    this.contracts = contracts;
    this.publish = this.publish.bind(this);
  }
  open(id, request, authority) {
    return this.owner.request(id, request, authority, {
      begin: (...args) => this.owner.port.beginStream?.(...args) ?? "input",
      publish: this.publish,
      prepare: (entry) => {
        const reject = entry.reject;
        entry.stream = { opened: false, next: 1, bytes: 0, credit: null };
        entry.reject = (error) => {
          reject(error);
          entry.stream.credit?.reject(error);
          entry.stream.credit = null;
        };
      },
    });
  }

  fail(entry, code = "stopped") {
    this.owner.withdraw(entry, code);
    return false; // Only a committed copied header/chunk acknowledges Go publication.
  }
  current(entry) {
    return (
      this.owner.authorityCurrent(entry) &&
      this.owner.port.current(entry.id) === true &&
      this.owner.authorityCurrent(entry)
    );
  }
  publish(token, id, result, code) {
    const entry = this.owner.tokens.get(token);
    if (!entry || entry.id !== id || entry.token !== token || !entry.stream)
      return false;
    if (!this.owner.authorityCurrent(entry)) return this.fail(entry);
    if (code) return this.fail(entry, code);
    try {
      return entry.stream.opened
        ? this.chunk(entry, result)
        : this.headers(entry, result);
    } catch {
      return this.fail(entry, "response");
    }
  }
  headers(entry, result) {
    if (!this.current(entry)) return this.fail(entry);
    const head = decodeHead(result);
    if (!this.current(entry) || !this.owner.identityCurrent(entry))
      return this.fail(entry);
    entry.stream.opened = true;
    entry.resolve(head); // Keep its original token/slot/listeners until EOF or cancellation.
    return true;
  }
  chunk(entry, result) {
    const credit = entry.stream.credit;
    if (!credit || !this.current(entry)) return this.fail(entry, "id");
    const packet = chunkSchema.parse(result);
    if (
      packet.sequence !== credit.sequence ||
      !bufferSchema.safeParse(packet.body.buffer).success ||
      packet.body.byteLength > MAX_CHUNK ||
      entry.stream.bytes + packet.body.byteLength > MAX_BODY
    )
      return this.fail(entry, "response");
    if (!this.current(entry) || entry.stream.credit !== credit)
      return this.fail(entry);
    const body = new Uint8Array(packet.body.byteLength);
    body.set(packet.body); // Owned copy; source access may run foreign getters or withdraw authority.
    if (
      !this.current(entry) ||
      !this.owner.identityCurrent(entry) ||
      entry.stream.credit !== credit
    )
      return this.fail(entry);
    entry.stream.bytes += body.byteLength;
    entry.stream.next++;
    entry.stream.credit = null;
    if (packet.eof && !this.owner.remove(entry)) return false;
    credit.resolve({ sequence: packet.sequence, body, eof: packet.eof });
    return true;
  }
  pull(id, sequence) {
    const { failure, safeID, errorCode } = this.contracts;
    if (!safeID(id) || !safeID(sequence)) return Promise.reject(failure("id"));
    const entry = this.owner.pending.get(id);
    if (!entry?.stream?.opened) return Promise.reject(failure("stopped"));
    if (entry.stream.credit || entry.stream.next !== sequence) {
      this.owner.withdraw(entry, "id");
      return Promise.reject(failure("id"));
    }
    return new Promise((resolve, reject) => {
      entry.stream.credit = { sequence, resolve, reject };
      try {
        if (!this.current(entry)) {
          this.owner.withdraw(entry);
          return;
        }
        const result = errorCode.safeParse(
          this.owner.port.pull?.(id, sequence, entry.token) ?? "input",
        );
        if (!result.success) this.owner.withdraw(entry, "network");
        else if (result.data) this.owner.withdraw(entry, result.data);
      } catch {
        this.owner.withdraw(entry, "network");
      }
    });
  }
}
