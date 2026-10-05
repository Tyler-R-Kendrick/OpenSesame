import { loadPack, packEntries } from "@opensesame/vault-item-types";

// Built-in packs arrive on demand in the app (ADR 0165); these suites are
// written against the whole corpus, so they switch every pack on first.
await Promise.all(packEntries().map((entry) => loadPack(entry.id)));
