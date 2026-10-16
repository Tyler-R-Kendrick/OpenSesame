/** A picked export is a volatile read-only snapshot, never a claimed remote password-manager session. */
import {
  ADAPTERS,
  type ParseInput,
  type ParseResult,
  parseImportAsync,
} from "../vault/import/index.js";
import { defaultMergeOptions, planMerge } from "../vault/import/merge.js";
import { importedItemView } from "./file-import-items.js";
import { readBackendImportFile } from "./file-import-read.js";
import {
  type LocalVaultPort,
  localVaultPort,
  localVaultSessionGuard,
} from "./local-vault-port.js";
import { secretBackendPreset } from "./presets.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendSession,
} from "./types.js";

type ImportedSession = {
  port: LocalVaultPort;
  guard: ReturnType<typeof localVaultSessionGuard>;
  parsed: ParseResult;
  items: SecretBackendItem[];
  importing: boolean;
  unsubscribe(): void;
};
function eraseImportedSession(
  held: Pick<ImportedSession, "parsed" | "items">,
): void {
  held.parsed.items.length = 0;
  held.items.length = 0;
}
function selectedItem(
  held: ImportedSession,
  reference: string,
): SecretBackendItem {
  const exact = held.items.find((item) => item.id === reference);
  if (exact) return exact;
  const matches = held.items.filter((item) => item.name === reference);
  if (matches.length > 1)
    throw new SecretBackendError(
      "ambiguous",
      "More than one imported item has that name. Select its item ID.",
    );
  const item = matches[0];
  if (!item)
    throw new SecretBackendError(
      "not-found",
      "That imported item was not found.",
    );
  return item;
}

export function createFileImportBackend(port?: LocalVaultPort): SecretBackend {
  return new FileImportBackend(port);
}
class FileImportBackend implements SecretBackend {
  readonly id = "file-import";
  readonly name = "Picked password-manager export";
  readonly capabilities = {
    list: true,
    get: true,
    create: false,
    update: false,
    delete: false,
    import: true,
  };
  readonly #sessions = createSecretBackendSessions<ImportedSession>(this.id);
  constructor(private readonly port?: LocalVaultPort) {}
  #state(session: SecretBackendSession): ImportedSession {
    const held = this.#sessions.read(session);
    held.guard.current();
    return held;
  }
  async authenticate(config: SecretBackendConfiguration) {
    const preset = secretBackendPreset(config.providerId);
    if (!preset?.fileFormats.some((format) => format.id === config.fileFormat))
      throw new SecretBackendError(
        "configuration",
        "Choose a supported export format for this provider.",
      );
    const adapter = ADAPTERS.find((entry) => entry.id === config.fileFormat);
    if (!adapter || !config.file)
      throw new SecretBackendError(
        "configuration",
        "Choose an export file and its format.",
      );
    const store = await localVaultPort(this.port);
    const guard = localVaultSessionGuard(store);
    try {
      const input = await readBackendImportFile(config.file, adapter.id);
      guard.current();
      if (
        (input.bytes !== null) !== (adapter.accepts === "binary") ||
        !adapter.detect(input)
      )
        throw new SecretBackendError(
          "response",
          `That file is not a ${adapter.label} export.`,
        );
      const parseInput: ParseInput = { ...input };
      if (config.filePassword !== undefined)
        parseInput.password = config.filePassword;
      const parsed = await parseImportAsync(parseInput, adapter.id);
      guard.current();
      if (parsed.needsPassword)
        throw new SecretBackendError(
          "authentication",
          "Enter the export password to open this file.",
        );
      if (input.skippedAttachments?.count)
        parsed.warnings.push(
          `${input.skippedAttachments.count} attachments were not imported; keep the original export to retain them.`,
        );
      const preview = planMerge(parsed.items, [], [], {
        ...defaultMergeOptions,
        skipDuplicates: false,
      });
      const held: ImportedSession = {
        port: store,
        guard,
        parsed,
        items: preview.items
          .map(importedItemView)
          .filter((item) => item !== null),
        importing: false,
        unsubscribe: () => {},
      };
      held.unsubscribe = store.onLock(() => {
        eraseImportedSession(held);
        held.unsubscribe();
        held.guard.close();
      });
      return this.#sessions.create(held);
    } catch (error) {
      guard.close();
      throw error;
    }
  }
  async listItems(session: SecretBackendSession) {
    return this.#state(session).items.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    }));
  }
  async getItem(reference: string, session: SecretBackendSession) {
    return structuredClone(selectedItem(this.#state(session), reference));
  }
  async getNotes(reference: string, session: SecretBackendSession) {
    return selectedItem(this.#state(session), reference).notes;
  }
  async importToLocal(session: SecretBackendSession) {
    const held = this.#state(session);
    if (held.importing)
      throw new SecretBackendError(
        "stale",
        "An import from this snapshot is already running.",
      );
    held.importing = true;
    try {
      const snapshot = held.guard.current();
      const plan = planMerge(
        held.parsed.items,
        snapshot.items,
        snapshot.folders,
        defaultMergeOptions,
      );
      const imported = await held.port.applyImport(plan);
      this.#state(session);
      return {
        imported,
        skipped: held.parsed.skipped.length + plan.duplicates.length,
        warnings: [...held.parsed.warnings],
      };
    } finally {
      held.importing = false;
    }
  }
  async disconnect(session: SecretBackendSession) {
    const held = this.#sessions.read(session);
    eraseImportedSession(held);
    held.unsubscribe();
    held.guard.close();
    this.#sessions.remove(session);
  }
}
