/**
 * Installs the UTF-8 codecs the moment the runtime contract loads, before
 * any bundled dependency evaluates: whatwg-url builds a `TextEncoder` at
 * module scope, so in an isolate without one it must already exist. Imported
 * first by `runtime-contract.ts`, only in an isolate bundle, and it fills a
 * missing global only — never replaces one the isolate has.
 */
import { SandboxTextDecoder, SandboxTextEncoder } from "./text.js";

for (const [name, value] of [
  ["TextEncoder", SandboxTextEncoder],
  ["TextDecoder", SandboxTextDecoder],
] as const) {
  if (
    !Object.hasOwn(globalThis, name) &&
    Reflect.get(globalThis, name) === undefined
  )
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
}
