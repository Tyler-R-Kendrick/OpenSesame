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
import {
  type Document,
  type Pair,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";
import {
  type ContextsDoc,
  type MacroDoc,
  type SettingsDoc,
  type SettingsField,
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
    patchField(document, field, was, current);
  }
  return document.toString();
}

function patchField(
  document: Document.Parsed,
  field: SettingsField,
  was: SettingsDoc | null,
  current: SettingsDoc,
): void {
  if (field.kind === "keymap") {
    patchBindings(document, ["keybindings"], current.keybindings);
    return;
  }
  if (field.kind === "contexts") {
    patchContexts(document, current.contexts ?? {});
    return;
  }
  if (field.kind === "macros") {
    patchMacros(document, was?.macros ?? {}, current.macros ?? {});
    return;
  }
  const value = current.values[field.key];
  if (value === undefined) {
    document.deleteIn([field.key]);
    return;
  }
  // A value that did not move keeps its spelling, its block or flow form
  // and every comment on it.
  const before = was?.values[field.key];
  if (before !== undefined && JSON.stringify(before) === JSON.stringify(value))
    return;
  const node = document.createNode(value, { flow: Array.isArray(value) });
  const existing = document.get(field.key, true);
  // Keep a trailing `# comment` on the line whose value moved.
  if (isNode(existing)) node.comment = existing.comment;
  document.set(field.key, node);
}

/** Macros are rewritten whole when they moved, and left alone when not. */
function patchMacros(
  document: Document.Parsed,
  before: Readonly<Record<string, MacroDoc>>,
  after: Readonly<Record<string, MacroDoc>>,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (Object.keys(after).length === 0) {
    document.deleteIn(["macros"]);
    return;
  }
  const node = document.createNode(after);
  for (const pair of isMap(node) ? node.items : []) {
    const steps = isMap(pair.value) ? pair.value.get("steps", true) : null;
    if (isSeq(steps)) steps.flow = true;
  }
  document.set("macros", node);
}

/**
 * Each context's keys patched in place, like `keybindings:`; a context left
 * with nothing goes, and so does `contexts:` once none is left.
 */
function patchContexts(
  document: Document.Parsed,
  contexts: Readonly<ContextsDoc>,
): void {
  const written = document.getIn(["contexts"], true);
  const names = new Set(Object.keys(contexts));
  if (isMap(written)) {
    for (const pair of written.items) names.add(nameOf(pair));
  } else if (written !== undefined) {
    document.deleteIn(["contexts"]);
  }
  for (const name of names) {
    patchBindings(document, ["contexts", name], contexts[name] ?? {});
  }
  const left = document.getIn(["contexts"], true);
  if (isMap(left) && left.items.length === 0) document.deleteIn(["contexts"]);
}

function nameOf(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function patchBindings(
  document: Document.Parsed,
  path: readonly string[],
  bindings: Readonly<Record<string, string>>,
): void {
  const keys = Object.keys(bindings);
  if (keys.length === 0) {
    if (document.hasIn(path)) document.deleteIn(path);
    return;
  }
  const map = document.getIn(path, true);
  if (!isMap(map)) {
    document.setIn(path, document.createNode({ ...bindings }));
    return;
  }
  // A hand-written `0: x` has the number 0 for a key: pairs are matched by
  // the text of their key, never by `map.get("0")`, which misses it.
  for (const pair of [...map.items]) {
    if (!Object.hasOwn(bindings, nameOf(pair)))
      map.items.splice(map.items.indexOf(pair), 1);
  }
  for (const [key, target] of Object.entries(bindings)) {
    const pair = map.items.find((item) => nameOf(item) === key);
    if (pair === undefined) map.set(key, target);
    else if (isScalar(pair.value)) {
      // Keep the comment on a line whose target moved.
      if (pair.value.value !== target) pair.value.value = target;
    } else pair.value = document.createNode(target);
  }
}
