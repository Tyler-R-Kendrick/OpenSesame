import { z } from "zod";

/** Original-node Promise publication owner for the unactivated Go BindJS port. */
const MAX_ID = Number.MAX_SAFE_INTEGER;
const CAPACITY = 4;
const DURATION = 30_000;
const messages = Object.freeze({
  input: "Invalid native HTTPS request.",
  id: "Invalid or consumed native HTTPS operation ID.",
  capacity: "Native HTTPS operation capacity reached.",
  stopped: "Native HTTPS authorization ended.",
  response: "Invalid native HTTPS response.",
  network: "Native HTTPS transport failed.",
});

const errorCode = z.enum([
  "",
  "input",
  "id",
  "capacity",
  "stopped",
  "response",
  "network",
]);
const ownerSchema = z.object({
  generation: z.unknown().refine((value) => value !== undefined),
  current: z.function(),
  signal: z.instanceof(AbortSignal),
});
const portSchema = z.object({
  begin: z.function(),
  current: z.function(),
  cancel: z.function(),
  close: z.function(),
});
function failure(code) {
  const parsed = errorCode.safeParse(code);
  return new Error(
    messages[parsed.success ? parsed.data : "network"] ?? messages.network,
  );
}
function safeID(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_ID;
}
function captureOwner(owner) {
  return Object.freeze(ownerSchema.parse(owner));
}
function capturePort(raw) {
  const parsed = portSchema.parse(raw);
  return Object.freeze({
    begin: parsed.begin.bind(raw),
    current: parsed.current.bind(raw),
    cancel: parsed.cancel.bind(raw),
    close: parsed.close.bind(raw),
  });
}

class NativeHTTPBinding {
  constructor(raw, owner) {
    try {
      this.port = capturePort(raw);
      this.captured = captureOwner(owner);
    } catch {
      throw failure("input");
    }
    this.pending = new Map();
    this.tokens = new Map();
    this.high = 0;
    this.closed = false;
    this.publish = this.publish.bind(this);
    this.closeHTTP = this.closeHTTP.bind(this);
    this.captured.signal.addEventListener("abort", this.closeHTTP, {
      once: true,
    });
    if (this.captured.signal.aborted) this.closeHTTP();
  }
  remove(entry) {
    if (this.pending.get(entry.id) !== entry) return false;
    this.pending.delete(entry.id);
    this.tokens.delete(entry.token);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    return true;
  }
  cancelRaw(id) {
    try {
      this.port.cancel(id);
    } catch {
      // Result withdrawal remains authoritative; Go still owns physical drain.
    }
  }
  withdraw(entry, code = "stopped") {
    if (!this.remove(entry)) return false;
    entry.reject(failure(code));
    this.cancelRaw(entry.id);
    return true;
  }
  identityCurrent(entry) {
    return (
      !this.closed &&
      this.pending.get(entry.id) === entry &&
      !this.captured.signal.aborted &&
      !entry.signal.aborted &&
      performance.now() < entry.deadline
    );
  }
  authorityCurrent(entry) {
    try {
      return (
        this.identityCurrent(entry) &&
        this.captured.current(this.captured.generation) === true &&
        entry.current(entry.generation) === true &&
        this.identityCurrent(entry)
      );
    } catch {
      return false;
    }
  }
  publish(token, id, result, code) {
    const entry = this.tokens.get(token);
    if (!entry || entry.token !== token || entry.id !== id) return false;
    if (!this.authorityCurrent(entry)) return this.withdraw(entry);
    if (code) {
      if (!this.remove(entry)) return false;
      entry.reject(failure(code));
      return true;
    }
    try {
      if (this.port.current(entry.id) !== true || !this.authorityCurrent(entry))
        return this.withdraw(entry);
      // No await or callback lies between this final identity fence and resolve.
      if (!this.identityCurrent(entry) || !this.remove(entry)) return false;
      entry.resolve(result);
      return true;
    } catch {
      return this.withdraw(entry, "network");
    }
  }
  admit(id, request, authority, resolve, reject) {
    let authorityOwner;
    try {
      authorityOwner = captureOwner(authority);
    } catch {
      this.cancelRaw(id);
      reject(failure("input"));
      return;
    }
    if (authorityOwner.generation !== this.captured.generation) {
      this.cancelRaw(id);
      reject(failure("stopped"));
      return;
    }
    const { signal, current } = authorityOwner;
    const token = Object.freeze({ id });
    const entry = {
      id,
      token,
      signal,
      current,
      generation: this.captured.generation,
      deadline: performance.now() + DURATION,
      resolve,
      reject,
      abort: null,
      timer: undefined,
    };
    entry.abort = () => this.withdraw(entry);
    this.pending.set(id, entry);
    this.tokens.set(token, entry);
    signal.addEventListener("abort", entry.abort, { once: true });
    entry.timer = setTimeout(entry.abort, DURATION);
    if (!this.authorityCurrent(entry)) {
      this.withdraw(entry);
      return;
    }
    try {
      // Reserve occurs synchronously inside Go before its Run goroutine starts.
      const result = errorCode.safeParse(
        this.port.begin(id, request, token, this.publish),
      );
      if (!result.success) this.withdraw(entry, "network");
      else if (result.data && this.remove(entry)) reject(failure(result.data));
    } catch {
      this.withdraw(entry, "network");
    }
  }
  nativeHTTP(id, request, authority) {
    if (!safeID(id) || id <= this.high) return Promise.reject(failure("id"));
    this.high = id;
    if (this.closed) return Promise.reject(failure("stopped"));
    if (this.pending.size >= CAPACITY) {
      this.cancelRaw(id); // A rejected new safe attempt is consumed by Go too.
      return Promise.reject(failure("capacity"));
    }
    return new Promise((resolve, reject) =>
      this.admit(id, request, authority, resolve, reject),
    );
  }
  cancelHTTP(id) {
    if (!safeID(id) || this.closed) return false;
    this.high = Math.max(this.high, id);
    const entry = this.pending.get(id);
    if (entry) return this.withdraw(entry);
    this.cancelRaw(id); // Unknown future cancellation burns the ID without a tombstone.
    return false;
  }
  closeHTTP() {
    if (this.closed) return true;
    this.closed = true;
    this.captured.signal.removeEventListener("abort", this.closeHTTP);
    for (const entry of this.pending.values()) this.withdraw(entry);
    // Pending tokens are gone before fixed Go callbacks are released.
    try {
      this.port.close();
      return true;
    } catch {
      return false; // No acknowledgement of Go cleanup when its callback failed.
    }
  }
}

/** Bind once to the original Go node and lease generation; never a current-node lookup. */
export function bindNativeHTTP(raw, owner) {
  const binding = new NativeHTTPBinding(raw, owner);
  return Object.freeze({
    nativeHTTP: binding.nativeHTTP.bind(binding),
    cancelHTTP: binding.cancelHTTP.bind(binding),
    closeHTTP: binding.closeHTTP,
  });
}
