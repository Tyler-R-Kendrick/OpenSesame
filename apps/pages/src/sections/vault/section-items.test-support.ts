/**
 * The three vault records `VaultSection`'s suites build on — one login, one
 * note, one drop — each with every field the model requires and an override
 * hook for the one a test cares about. Test support: never imported by the
 * app. Lifted out of `VaultSection.test.tsx` to keep that file inside the
 * module-size budget (ADR 0093).
 */

import type {
  DropItem,
  LoginItem,
  NoteItem,
} from "@opensesame/app-core/lib/vault/model.js";

export function makeLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "itm_1",
    kind: "login",
    name: "Webmail",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    deletedAt: null,
    username: "me@example.com",
    password: "hunter2hunter2hunter2",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

export function makeNote(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    id: "itm_2",
    kind: "note",
    name: "Scratch pad",
    folderId: null,
    favorite: false,
    notes: "remember the milk",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

export function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
  return {
    id: "itm_drop",
    kind: "drop",
    name: "amber-falcon-breeze",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    state: "pending",
    claimId: "clm_1",
    bearerToken: "osc_clm_clm_1.secret",
    expiresAt: "2027-01-15T10:30:00.000Z",
    ...overrides,
  };
}
