/**
 * Where a key applies (ADR 0150 §6). The keymap holds everywhere; a context
 * lays a person's own keys over it only while the keyboard is in one listing.
 * A closed set — VS Code's `when`, Steam's action sets, vim's modes — with no
 * expression language: the vault listing or the rail tree, nothing else.
 */
export type KeymapContext = "vault" | "rail";

export const KEYMAP_CONTEXTS: readonly KeymapContext[] = ["vault", "rail"];

/** How a scope reads in a sentence: "`d` edits in the vault list". */
export const CONTEXT_LABEL = {
  vault: "in the vault list",
  rail: "in the rail",
} as const satisfies Readonly<Record<KeymapContext, string>>;

/** Sequence → target, per context. Sparse: an absent context is empty. */
export type KeymapContexts = Readonly<
  Partial<Record<KeymapContext, Readonly<Record<string, string>>>>
>;

export function isKeymapContext(value: string): value is KeymapContext {
  return value === "vault" || value === "rail";
}
