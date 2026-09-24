/**
 * A settings directory's `config.yaml` as the person last wrote it, brought up
 * to date with what the page now holds.
 *
 * The page and the file are one set of values. When the form changes a value
 * the file must say so — but the file is also the person's document, with
 * their comments and their ordering. So the stored text is not thrown away
 * and re-derived: it is parsed as a YAML document, only the values that moved
 * are rewritten in place, and comments ride along untouched.
 */
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";
import {
  type SettingsDoc,
  decodeSettings,
  encodeSettings,
  sameDoc,
  settingsFields,
} from "./settings-files.js";

/**
 * The text to show for `category`'s `config.yaml`: the saved spelling when it
 * still says what the page says, the saved spelling patched when it does not,
 * and a freshly derived file when there is nothing usable to patch.
 */
export function reconcileSource(
  category: string,
  saved: string | undefined,
  current: SettingsDoc,
): string {
  const fresh = encodeSettings(category, current);
  if (saved === undefined) return fresh;
  const decoded = decodeSettings(category, saved);
  if (!decoded.ok) return fresh;
  if (sameDoc(decoded.doc, current)) return saved;
  const patched = patch(category, saved, current);
  if (patched === null) return fresh;
  const check = decodeSettings(category, patched);
  return check.ok && sameDoc(check.doc, current) ? patched : fresh;
}

function patch(
  category: string,
  saved: string,
  current: SettingsDoc,
): string | null {
  const document = parseDocument(saved);
  if (document.errors.length > 0) return null;
  if (document.contents === null) {
    // A file of only comments: keep them above the values it now needs.
    const values = encodeSettings(category, current);
    return `${saved.replace(/\n*$/, "\n")}${values}`;
  }
  if (!isMap(document.contents)) return null;
  const written = decodeSettings(category, saved);
  const was = written.ok ? written.doc : null;
  for (const field of settingsFields(category)) {
    if (field.kind === "keymap") {
      patchBindings(document, current.keybindings);
      continue;
    }
    const value = current.values[field.key];
    if (value === undefined) {
      document.deleteIn([field.key]);
      continue;
    }
    // A value that did not move keeps its spelling, its block or flow form
    // and every comment on it.
    const before = was?.values[field.key];
    if (
      before !== undefined &&
      JSON.stringify(before) === JSON.stringify(value)
    )
      continue;
    const node = document.createNode(value, { flow: Array.isArray(value) });
    const existing = document.get(field.key, true);
    // Keep a trailing `# comment` on the line whose value moved.
    if (isNode(existing)) node.comment = existing.comment;
    document.set(field.key, node);
  }
  return document.toString();
}

function patchBindings(
  document: Document.Parsed,
  bindings: Readonly<Record<string, string>>,
): void {
  const keys = Object.keys(bindings);
  if (keys.length === 0) {
    document.deleteIn(["keybindings"]);
    return;
  }
  const map = document.get("keybindings", true);
  if (!isMap(map)) {
    document.set("keybindings", document.createNode({ ...bindings }));
    return;
  }
  for (const pair of [...map.items]) {
    const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (!(name in bindings)) map.delete(name);
  }
  for (const key of keys) {
    const before = map.get(key);
    if (before !== bindings[key]) map.set(key, bindings[key]);
  }
}
