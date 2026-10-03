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
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
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
import { stableMacro, stableMacros } from "./settings-keymap-yaml.js";

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

/**
 * Macros patched one entry at a time: a macro that did not move keeps its
 * spelling, its comments and its place; one that moved has only the moved
 * field (`on:` or `steps:`) rewritten.
 */
function patchMacros(
  document: Document.Parsed,
  before: Readonly<Record<string, MacroDoc>>,
  after: Readonly<Record<string, MacroDoc>>,
): void {
  if (stableMacros(before) === stableMacros(after)) return;
  if (Object.keys(after).length === 0) {
    document.deleteIn(["macros"]);
    return;
  }
  const written = document.get("macros", true);
  if (!isMap(written)) {
    const node = document.createNode(after);
    for (const pair of isMap(node) ? node.items : []) {
      const steps = isMap(pair.value) ? pair.value.get("steps", true) : null;
      if (isSeq(steps)) steps.flow = true;
    }
    document.set("macros", node);
    return;
  }
  const was = renameInPlace(written, before, after);
  for (const pair of [...written.items]) {
    if (!Object.hasOwn(after, nameOf(pair))) removePair(written, pair);
  }
  for (const [name, macro] of Object.entries(after)) {
    const pair = written.items.find((item) => nameOf(item) === name);
    if (pair === undefined) written.set(name, macroNode(document, macro));
    else if (stableMacro(was[name]) !== stableMacro(macro))
      patchMacro(document, pair, macro);
  }
}

/**
 * A macro that vanished while another with exactly the same trigger and steps
 * appeared is a rename: its key is swapped where it stands, so the macro keeps
 * its place, its comments and its spelling. Returns `before` under the names
 * the file now uses.
 */
function renameInPlace(
  written: YAMLMap,
  before: Readonly<Record<string, MacroDoc>>,
  after: Readonly<Record<string, MacroDoc>>,
): Record<string, MacroDoc> {
  const was = { ...before };
  const names = written.items.map(nameOf);
  const fresh = Object.keys(after).filter((name) => !names.includes(name));
  for (const pair of written.items) {
    const old = nameOf(pair);
    if (Object.hasOwn(after, old) || !isScalar(pair.key)) continue;
    const to = fresh.find(
      (name) => stableMacro(after[name]) === stableMacro(was[old]),
    );
    if (to === undefined) continue;
    fresh.splice(fresh.indexOf(to), 1);
    pair.key.value = to;
    was[to] = was[old] as MacroDoc;
    delete was[old];
  }
  return was;
}

/**
 * Takes `pair` out of `map`. YAML hangs the comment above a map's first entry
 * on the map itself, so removing the first entry must take that comment with
 * it and hand the next entry's own leading comment up to the map — otherwise
 * it would be left above an entry it was never written for.
 */
function removePair(map: YAMLMap, pair: Pair): void {
  const at = map.items.indexOf(pair);
  if (at === -1) return;
  map.items.splice(at, 1);
  if (at !== 0) return;
  const next = map.items[0]?.key;
  map.commentBefore = isNode(next) ? next.commentBefore : undefined;
  if (isNode(next)) next.commentBefore = undefined;
}

function macroNode(document: Document.Parsed, macro: MacroDoc): Node {
  const node = document.createNode(macro);
  const steps = isMap(node) ? node.get("steps", true) : null;
  if (isSeq(steps)) steps.flow = true;
  return node;
}

function patchMacro(
  document: Document.Parsed,
  pair: Pair,
  macro: MacroDoc,
): void {
  if (!isMap(pair.value)) {
    // The bare `name: [steps]` spelling has no `on:`; a macro that now has
    // one is written out as a mapping.
    if (isSeq(pair.value) && macro.on === undefined) {
      patchSteps(document, pair, macro.steps);
    } else pair.value = macroNode(document, macro);
    return;
  }
  const body = pair.value;
  if (macro.on === undefined) body.delete("on");
  else if (!body.has("on"))
    body.items.unshift(document.createPair("on", macro.on));
  else if (body.get("on") !== macro.on) body.set("on", macro.on);
  const steps = body.get("steps", true);
  if (!isSeq(steps)) body.set("steps", stepsNode(document, macro.steps, true));
  else if (JSON.stringify(steps.toJSON()) !== JSON.stringify(macro.steps)) {
    body.set("steps", stepsNode(document, macro.steps, steps.flow, steps));
  }
}

function patchSteps(
  document: Document.Parsed,
  pair: Pair,
  steps: readonly string[],
): void {
  const old = pair.value;
  if (!isSeq(old)) return;
  if (JSON.stringify(old.toJSON()) === JSON.stringify(steps)) return;
  pair.value = stepsNode(document, steps, old.flow, old);
}

/**
 * A step list rewritten in the spelling it was written in: a missing `flow`
 * means a block list, so only a list that was a flow list (or has no old
 * spelling) is written as one. A step that is still there keeps the item node
 * it had, so a comment on its line rides along; the comments above and beside
 * the list itself stay too.
 */
function stepsNode(
  document: Document.Parsed,
  steps: readonly string[],
  flow: boolean | undefined,
  old?: YAMLSeq,
): Node {
  const node = document.createNode([...steps], {
    flow: old === undefined ? true : flow === true,
  });
  if (old === undefined || !isSeq(node)) return node;
  node.comment = old.comment;
  node.commentBefore = old.commentBefore;
  const spare = old.items.filter(isScalar);
  node.items = node.items.map((item) => {
    const same = spare.findIndex(
      (kept) => isScalar(item) && kept.value === item.value,
    );
    return same === -1 ? item : (spare.splice(same, 1)[0] ?? item);
  });
  return node;
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
    if (!Object.hasOwn(bindings, nameOf(pair))) removePair(map, pair);
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
