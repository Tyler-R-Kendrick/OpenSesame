/**
 * YAML documents → ordered SOPS trees, typed the way the pinned Go loader
 * types them (B05). Structure comes from the pinned `yaml` package's AST;
 * plain scalars are resolved from their source text with yaml.v3's rules;
 * comments are placed from source offsets (see yaml-comments.ts).
 *
 * Declared refusals, each before any key material is touched: aliases,
 * merge keys, non-string or complex keys, duplicate keys, tags outside the
 * YAML core set, sequence or scalar documents, and a stream with no
 * document at all.
 */

import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Document,
  type Node,
  type Pair,
  type Scalar,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
} from "yaml";
import { SopsError } from "./errors.js";
import { MAX_DOCUMENTS, MAX_INPUT_BYTES, MAX_KEY_LENGTH } from "./limits.js";
import {
  type SopsMapItem,
  type SopsNode,
  type SopsSeqItem,
  assertTreeBudget,
} from "./model.js";
import { assertScalarBudget } from "./scalars.js";
import {
  type ScanCollection,
  type ScanItem,
  attachComments,
} from "./yaml-comments.js";
import { type YamlResolved, resolvePlainScalar } from "./yaml-resolve.js";

const CORE = "tag:yaml.org,2002:";

/** The YAML core tags this profile understands, by their full tag URI. */
type TypedTags = Readonly<
  Record<string, "str" | "int" | "float" | "bool" | "null" | "time">
>;
const TYPED_TAGS: TypedTags = {
  [`${CORE}str`]: "str",
  [`${CORE}int`]: "int",
  [`${CORE}float`]: "float",
  [`${CORE}bool`]: "bool",
  [`${CORE}null`]: "null",
  [`${CORE}timestamp`]: "time",
};

type Build = {
  text: string;
  items: ScanItem[];
  protectedRanges: [number, number][];
};

function unsupported(what: string): SopsError {
  return new SopsError(
    "unsupported_feature",
    `YAML ${what} is outside the supported profile.`,
  );
}

function columnOf(text: string, offset: number): number {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return offset - lineStart;
}

function rangeOf(node: Node): [number, number] {
  const range = node.range;
  if (!range)
    throw new SopsError("invalid_document", "A YAML node has no source range.");
  return [range[0], range[1]];
}

function taggedScalar(
  tag: string,
  source: string,
  literal: boolean,
  textValue: string,
): YamlResolved {
  const typed = TYPED_TAGS[tag];
  if (!typed) throw unsupported("tag");
  if (typed === "str") {
    return {
      kind: "scalar",
      scalar: { kind: "str", value: literal ? textValue : source },
    };
  }
  const resolved = resolvePlainScalar(literal ? textValue : source);
  const kind = resolved.kind === "null" ? "null" : resolved.scalar.kind;
  if (kind !== typed)
    throw unsupported("tagged value that does not resolve to its tag");
  return resolved;
}

function resolveScalar(node: Scalar): YamlResolved {
  const source = node.source ?? "";
  const literal =
    node.type === "QUOTE_DOUBLE" ||
    node.type === "QUOTE_SINGLE" ||
    node.type === "BLOCK_LITERAL" ||
    node.type === "BLOCK_FOLDED";
  // SAFETY: a parsed scalar's value is a JSON primitive the library
  // produced; `isString` is the check, and a non-string falls back to source.
  const parsedValue: BoundaryValue = overlapCast(node.value);
  const textValue = isString(parsedValue) ? parsedValue : source;
  const tag = node.tag;
  if (tag !== undefined && tag !== null)
    return taggedScalar(tag, source, literal, textValue);
  if (literal)
    return { kind: "scalar", scalar: { kind: "str", value: textValue } };
  return resolvePlainScalar(source);
}

type MappingKey = { key: string; offset: number };

function keyOf(pair: Pair): MappingKey {
  const keyNode = pair.key;
  if (!isScalar(keyNode)) throw unsupported("complex mapping key");
  const resolved = resolveScalar(keyNode);
  if (resolved.kind !== "scalar" || resolved.scalar.kind !== "str") {
    throw unsupported("non-string mapping key");
  }
  const key = resolved.scalar.value;
  if (key === "<<") throw unsupported("merge key");
  if (key.length > MAX_KEY_LENGTH) {
    throw new SopsError(
      "resource_limit",
      "A mapping key exceeds the key budget.",
    );
  }
  return { key, offset: rangeOf(keyNode)[0] };
}

function dashOffsets(node: Node): number[] {
  const token = node.srcToken;
  if (!token || token.type !== "block-seq") return [];
  return token.items.map((item) => {
    const dash = item.start.find((start) => start.type === "seq-item-ind");
    return dash ? dash.offset : -1;
  });
}

function convertScalar(build: Build, node: Scalar, item: ScanItem): SopsNode {
  const range = rangeOf(node);
  // A block scalar's range starts at its `|` or `>` header; a comment on
  // that header line is a real comment, so only the content is shielded.
  const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
  const contentStart = block
    ? build.text.indexOf("\n", range[0]) + 1
    : range[0];
  build.protectedRanges.push([
    contentStart > 0 ? contentStart : range[0],
    range[1],
  ]);
  item.valueRange = range;
  const resolved = resolveScalar(node);
  if (resolved.kind === "null") return { kind: "null" };
  if (resolved.scalar.kind === "str") assertScalarBudget(resolved.scalar.value);
  return { kind: "scalar", scalar: resolved.scalar };
}

function convertValue(
  build: Build,
  node: Node | null,
  parent: ScanCollection,
  item: ScanItem,
): SopsNode {
  if (node === null) return { kind: "null" };
  if (isAlias(node)) throw unsupported("alias");
  if (isScalar(node)) return convertScalar(build, node, item);
  if (isMap(node) || isSeq(node)) {
    const tag = node.tag;
    if (
      tag !== undefined &&
      tag !== null &&
      tag !== `${CORE}map` &&
      tag !== `${CORE}seq`
    ) {
      throw unsupported("tag");
    }
    const collection = convertCollection(build, node, parent);
    item.child = collection;
    return collection.kind === "map"
      ? { kind: "map", items: [] }
      : { kind: "seq", items: [] };
  }
  throw unsupported("node");
}

function convertCollection(
  build: Build,
  node: Node,
  parent: ScanCollection | null,
): ScanCollection {
  const flow = "flow" in node && node.flow === true;
  const collection: ScanCollection = {
    kind: isMap(node) ? "map" : "seq",
    parent,
    indent: 0,
    items: [],
    flowRange: flow ? rangeOf(node) : null,
    foot: [],
  };
  if (isMap(node)) {
    const seen = new Set<string>();
    for (const pair of node.items) {
      const { key, offset } = keyOf(pair);
      if (seen.has(key))
        throw new SopsError("duplicate_key", "A mapping repeats a key.");
      seen.add(key);
      if (isScalar(pair.key)) build.protectedRanges.push(rangeOf(pair.key));
      const item: ScanItem = {
        collection,
        start: offset,
        child: null,
        valueRange: null,
        before: [],
        key,
        value: { kind: "null" },
      };
      collection.items.push(item);
      build.items.push(item);
      const value = pair.value;
      item.value = convertValue(
        build,
        isNode(value) ? value : null,
        collection,
        item,
      );
    }
  } else if (isSeq(node)) {
    const dashes = dashOffsets(node);
    node.items.forEach((child, index) => {
      if (!isNode(child)) throw unsupported("sequence item");
      const childNode = child;
      const dash = dashes[index];
      const item: ScanItem = {
        collection,
        start: dash !== undefined && dash >= 0 ? dash : rangeOf(childNode)[0],
        child: null,
        valueRange: null,
        before: [],
        key: null,
        value: { kind: "null" },
      };
      collection.items.push(item);
      build.items.push(item);
      item.value = convertValue(build, childNode, collection, item);
    });
  }
  const first = collection.items[0];
  collection.indent = first ? columnOf(build.text, first.start) : 0;
  return collection;
}

function assemble(collection: ScanCollection): SopsNode {
  if (collection.kind === "map") {
    const items: SopsMapItem[] = [];
    for (const item of collection.items) {
      items.push(...item.before);
      items.push({
        kind: "entry",
        key: item.key ?? "",
        value: item.child ? assemble(item.child) : item.value,
      });
    }
    items.push(...collection.foot);
    return { kind: "map", items };
  }
  const items: SopsSeqItem[] = [];
  for (const item of collection.items) {
    items.push(...item.before);
    items.push(item.child ? assemble(item.child) : item.value);
  }
  items.push(...collection.foot);
  return { kind: "seq", items };
}

function convertDocument(
  text: string,
  doc: Document,
  sole: boolean,
  windowStart: number,
): SopsNode {
  if (doc.errors.length > 0) {
    const duplicate = doc.errors.some(
      (error) => error.code === "DUPLICATE_KEY",
    );
    throw duplicate
      ? new SopsError("duplicate_key", "A mapping repeats a key.")
      : new SopsError("invalid_document", "The YAML stream does not parse.");
  }
  if (doc.warnings.some((warning) => warning.code === "TAG_RESOLVE_FAILED"))
    throw unsupported("tag");
  const contents = doc.contents;
  const build: Build = { text, items: [], protectedRanges: [] };
  let root: ScanCollection;
  if (
    contents === null ||
    (isScalar(contents) && contents.value === null && !contents.tag)
  ) {
    if (sole && !doc.directives?.docStart) {
      throw new SopsError(
        "invalid_document",
        "The YAML stream holds no document.",
      );
    }
    root = {
      kind: "map",
      parent: null,
      indent: 0,
      items: [],
      flowRange: null,
      foot: [],
    };
  } else if (isMap(contents)) {
    root = convertCollection(build, contents, null);
  } else {
    throw new SopsError(
      "invalid_document",
      "A SOPS YAML document must be a mapping.",
    );
  }
  // Comments belong to the document whose source window holds them: from
  // the previous document's end (leading comments sit before the parser's
  // own range) to this document's end.
  const end = doc.range?.[2] ?? text.length;
  const slice = `${text.slice(0, windowStart).replace(/[^\n]/gu, " ")}${text.slice(windowStart, end)}`;
  attachComments(slice, root, build.items, build.protectedRanges);
  return assemble(root);
}

/** Parse a YAML stream into one ordered tree per document. */
export function parseYamlDocuments(text: string): SopsNode[] {
  if (text.length > MAX_INPUT_BYTES) {
    throw new SopsError(
      "resource_limit",
      "The document exceeds the input budget.",
    );
  }
  let docs: Document[];
  try {
    docs = parseAllDocuments(text, {
      keepSourceTokens: true,
      intAsBigInt: true,
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: "silent",
    });
  } catch {
    throw new SopsError("invalid_document", "The YAML stream does not parse.");
  }
  if (docs.length > MAX_DOCUMENTS) {
    throw new SopsError(
      "resource_limit",
      "The YAML stream has too many documents.",
    );
  }
  if (docs.length === 0) {
    throw new SopsError(
      "invalid_document",
      "The YAML stream holds no document.",
    );
  }
  const roots = docs.map((doc, index) =>
    convertDocument(
      text,
      doc,
      docs.length === 1,
      index === 0 ? 0 : (docs[index - 1]?.range?.[2] ?? 0),
    ),
  );
  assertTreeBudget(roots);
  return roots;
}
