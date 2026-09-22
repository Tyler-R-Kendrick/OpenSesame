/**
 * The browser SOPS engine (B03, B11): inspect, open, encrypt, same-DEK save,
 * and rotation over the ordered-tree codecs, the upstream walk, the age
 * envelope, and key-group recovery. No Host, no `sops` binary, no
 * environment variable: everything here runs on the page's own thread or in
 * `sops.worker.ts`.
 *
 * Plaintext is released only after every AES-GCM tag and the document MAC
 * verify (SB-023). A verified document lives behind a handle bound to the
 * session generation and vault scope; a bump disposes it and zeroes its
 * data key.
 */

import {
  type LoadedFile,
  type SopsFormat,
  assertNoReservedKey,
  emitEncrypted,
  emitPlain,
  loadFile,
  parseDocuments,
} from "./document.js";
import { SopsError } from "./errors.js";
import type { HandleRegistry, HandleScope } from "./handles.js";
import { type Inspection, inspectText } from "./inspect.js";
import {
  type MasterKeyProvider,
  type RecoveryReport,
  recoverDataKey,
  wrapDataKey,
} from "./keys/groups.js";
import { DATA_KEY_BYTES } from "./limits.js";
import { SOPS_VERSION, type SopsMetadata } from "./metadata.js";
import type { SopsMap } from "./model.js";
import {
  type EncryptionPlan,
  type ExecutionPermit,
  assertPermitted,
  validatePlan,
} from "./plan.js";
import { lastModifiedNow } from "./time.js";
import { decryptMac, decryptTree, encryptMac, encryptTree } from "./walk.js";

export type { SopsFormat } from "./document.js";
export type { Inspection } from "./inspect.js";

export type VerifiedDocument = {
  format: SopsFormat;
  roots: SopsMap[];
  metadata: SopsMetadata;
  key: Uint8Array;
  scope: HandleScope;
};

export type OpenOptions = {
  identities: readonly string[];
  providers?: readonly MasterKeyProvider[];
  permit: ExecutionPermit;
  signal: AbortSignal;
};

export type OpenResult = {
  handle: string;
  plaintext: string;
  inspection: Inspection;
  report: RecoveryReport;
};

export type EncryptOptions = {
  plan: EncryptionPlan;
  permit: ExecutionPermit;
  providers?: readonly MasterKeyProvider[];
  signal: AbortSignal;
  now?: Date;
};

function scopeOf(permit: ExecutionPermit): HandleScope {
  return {
    sessionGeneration: permit.scope.sessionGeneration,
    vaultScope: permit.scope.vaultScope,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new SopsError("canceled", "The SOPS operation was canceled.");
}

function providersFor(
  permit: ExecutionPermit,
  providers: readonly MasterKeyProvider[] | undefined,
): MasterKeyProvider[] {
  if (permit.network === "forbidden") return [];
  return [...(providers ?? [])];
}

/** A document sealed under one data key: the tree and the block above it. */
export type SealedDocument = {
  roots: SopsMap[];
  metadata: SopsMetadata;
};

async function sealTree(
  roots: readonly SopsMap[],
  key: Uint8Array,
  metadata: Omit<SopsMetadata, "mac" | "lastModified" | "version">,
  now: Date,
): Promise<SealedDocument> {
  assertNoReservedKey(roots);
  const sealed = await encryptTree(roots, key, metadata.policy);
  const lastModified = lastModifiedNow(now);
  const mac = encryptMac(sealed.macHex, key, lastModified);
  const maps = sealed.roots.map((root) => {
    if (root.kind !== "map")
      throw new SopsError(
        "invalid_document",
        "Every SOPS document is a mapping.",
      );
    return root;
  });
  return {
    roots: maps,
    metadata: { ...metadata, mac, lastModified, version: SOPS_VERSION },
  };
}

export class SopsEngine {
  readonly #handles: HandleRegistry<VerifiedDocument>;

  constructor(handles: HandleRegistry<VerifiedDocument>) {
    this.#handles = handles;
  }

  /** Bounded parsing and untrusted facts; nothing is decrypted. */
  inspect(text: string, format: SopsFormat): Inspection {
    return inspectText(text, format);
  }

  /** Recover the data key, decrypt, verify the MAC, and mint a handle. */
  async open(
    text: string,
    format: SopsFormat,
    options: OpenOptions,
  ): Promise<OpenResult> {
    const scope = scopeOf(options.permit);
    this.#handles.assertLive(scope);
    const loaded: LoadedFile = loadFile(text, format);
    if (!loaded.metadata) {
      throw new SopsError(
        "invalid_document",
        "The file has no sops metadata; use Encrypt for a new document.",
      );
    }
    const metadata = loaded.metadata;
    if (metadata.mac === "") {
      throw new SopsError(
        "authentication_failed",
        "The document carries no MAC.",
      );
    }
    throwIfAborted(options.signal);
    const recovered = await recoverDataKey(metadata, {
      identities: options.identities,
      providers: providersFor(options.permit, options.providers),
      signal: options.signal,
    });
    const key = recovered.key;
    try {
      this.#handles.assertLive(scope);
      throwIfAborted(options.signal);
      const opened = await decryptTree(loaded.roots, key, metadata.policy);
      const storedMac = decryptMac(metadata.mac, key, metadata.lastModified);
      if (storedMac !== opened.macHex) {
        throw new SopsError(
          "authentication_failed",
          "The document MAC does not match its contents.",
        );
      }
      this.#handles.assertLive(scope);
      throwIfAborted(options.signal);
      const roots = opened.roots.map((root) => {
        if (root.kind !== "map")
          throw new SopsError(
            "invalid_document",
            "Every SOPS document is a mapping.",
          );
        return root;
      });
      const document: VerifiedDocument = {
        format,
        roots,
        metadata,
        key,
        scope,
      };
      const handle = this.#handles.mint(document, scope, [key]);
      return {
        handle,
        plaintext: emitPlain(roots, format),
        inspection: inspectText(text, format),
        report: recovered.report,
      };
    } catch (caught) {
      key.fill(0);
      throw caught;
    }
  }

  /** The verified plaintext of an open document. */
  plaintext(handle: string, permit: ExecutionPermit): string {
    const document = this.#handles.get(handle, scopeOf(permit));
    return emitPlain(document.roots, document.format);
  }

  /**
   * Ordinary edit: the same data key, every existing wrapper and the
   * embedded policy verbatim, fresh nonces for every value and the MAC.
   */
  async saveEdited(
    handle: string,
    edited: string,
    permit: ExecutionPermit,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<string> {
    const scope = scopeOf(permit);
    const document = this.#handles.get(handle, scope);
    const roots = parseDocuments(edited, document.format);
    throwIfAborted(signal);
    const sealed = await sealTree(roots, document.key, document.metadata, now);
    this.#handles.assertLive(scope);
    throwIfAborted(signal);
    return emitEncrypted(sealed.roots, sealed.metadata, document.format);
  }

  /** A new document under a fresh data key and an approved plan. */
  async encryptNew(text: string, options: EncryptOptions): Promise<string> {
    const scope = scopeOf(options.permit);
    this.#handles.assertLive(scope);
    validatePlan(options.plan);
    await assertPermitted(options.plan, options.permit);
    const roots = parseDocuments(text, options.plan.format);
    assertNoReservedKey(roots);
    const key = new Uint8Array(DATA_KEY_BYTES);
    crypto.getRandomValues(key);
    try {
      return await this.#sealNew(roots, key, options, scope);
    } finally {
      key.fill(0);
    }
  }

  /** Rotate an open document: new data key, complete new wrapper set. */
  async rotate(
    handle: string,
    edited: string | null,
    options: EncryptOptions,
  ): Promise<string> {
    const scope = scopeOf(options.permit);
    const document = this.#handles.get(handle, scope);
    validatePlan(options.plan);
    await assertPermitted(options.plan, options.permit);
    if (options.plan.format !== document.format) {
      throw new SopsError(
        "unauthorized_policy",
        "The plan's format differs from the document's.",
      );
    }
    const roots =
      edited === null
        ? document.roots
        : parseDocuments(edited, document.format);
    const key = new Uint8Array(DATA_KEY_BYTES);
    crypto.getRandomValues(key);
    try {
      return await this.#sealNew(roots, key, options, scope);
    } finally {
      key.fill(0);
    }
  }

  async #sealNew(
    roots: readonly SopsMap[],
    key: Uint8Array,
    options: EncryptOptions,
    scope: HandleScope,
  ): Promise<string> {
    const plan = options.plan;
    throwIfAborted(options.signal);
    const groups = await wrapDataKey(
      key,
      plan.groups,
      plan.groups.length > 1
        ? plan.shamirThreshold === 0
          ? plan.groups.length
          : plan.shamirThreshold
        : 1,
      providersFor(options.permit, options.providers),
      options.signal,
    );
    this.#handles.assertLive(scope);
    const sealed = await sealTree(
      roots,
      key,
      {
        layout: groups.length > 1 ? "groups" : "flat",
        groups,
        shamirThreshold:
          groups.length > 1
            ? plan.shamirThreshold === 0
              ? groups.length
              : plan.shamirThreshold
            : 0,
        policy: plan.policy,
      },
      options.now ?? new Date(),
    );
    this.#handles.assertLive(scope);
    throwIfAborted(options.signal);
    return emitEncrypted(sealed.roots, sealed.metadata, plan.format);
  }

  dispose(handle: string): void {
    this.#handles.dispose(handle);
  }

  disposeAll(): void {
    this.#handles.disposeAll();
  }
}
