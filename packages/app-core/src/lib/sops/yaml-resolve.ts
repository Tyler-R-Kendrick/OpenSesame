/**
 * Plain-scalar resolution as go.yaml.in/yaml/v3 `resolve` performs it for an
 * untagged scalar (resolve.go at v3.0.4). The pinned `yaml` npm package
 * follows YAML 1.2 core, which reads `017` as 17 and `0b101` as text; the Go
 * loader reads 15 and 5, so the engine resolves plain scalars itself.
 */

import { SopsError } from "./errors.js";
import {
  type SopsScalar,
  canonicalInt,
  goParseFloatText,
  goParseIntBase0,
} from "./scalars.js";
import { resolveYamlTimestamp } from "./time.js";

export type YamlResolved =
  | { kind: "null" }
  | { kind: "scalar"; scalar: SopsScalar };

const MAP: Record<string, YamlResolved> = {
  true: { kind: "scalar", scalar: { kind: "bool", value: true } },
  True: { kind: "scalar", scalar: { kind: "bool", value: true } },
  TRUE: { kind: "scalar", scalar: { kind: "bool", value: true } },
  false: { kind: "scalar", scalar: { kind: "bool", value: false } },
  False: { kind: "scalar", scalar: { kind: "bool", value: false } },
  FALSE: { kind: "scalar", scalar: { kind: "bool", value: false } },
  "": { kind: "null" },
  "~": { kind: "null" },
  null: { kind: "null" },
  Null: { kind: "null" },
  NULL: { kind: "null" },
  ".nan": { kind: "scalar", scalar: { kind: "float", value: Number.NaN } },
  ".NaN": { kind: "scalar", scalar: { kind: "float", value: Number.NaN } },
  ".NAN": { kind: "scalar", scalar: { kind: "float", value: Number.NaN } },
  ".inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  ".Inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  ".INF": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  "+.inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  "+.Inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  "+.INF": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.POSITIVE_INFINITY },
  },
  "-.inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.NEGATIVE_INFINITY },
  },
  "-.Inf": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.NEGATIVE_INFINITY },
  },
  "-.INF": {
    kind: "scalar",
    scalar: { kind: "float", value: Number.NEGATIVE_INFINITY },
  },
};

const YAML_FLOAT =
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/u;

type Hint = "sign" | "digit" | "map" | "dot" | "none";

function hint(text: string): Hint {
  const first = text.charAt(0);
  if (first === "+" || first === "-") return "sign";
  if (first >= "0" && first <= "9") return "digit";
  if ("yYnNtTfFoO~".includes(first) && first !== "") return "map";
  if (first === ".") return "dot";
  return "none";
}

function intScalar(value: bigint): YamlResolved {
  const text = canonicalInt(value);
  if (text === null) {
    // yaml.v3 yields uint64 here and upstream refuses to walk it.
    throw new SopsError(
      "unsupported_feature",
      "An integer is outside the 64-bit signed range SOPS supports.",
    );
  }
  return { kind: "scalar", scalar: { kind: "int", value: text } };
}

/**
 * Resolve an untagged plain scalar. `<<` is refused by the caller because
 * upstream would treat the merge key as data.
 */
export function resolvePlainScalar(text: string): YamlResolved {
  if (text === "") return { kind: "null" };
  const kind = hint(text);
  if (kind === "none")
    return { kind: "scalar", scalar: { kind: "str", value: text } };
  const mapped = MAP[text];
  if (mapped) return mapped;
  if (kind === "map") {
    return { kind: "scalar", scalar: { kind: "str", value: text } };
  }
  if (kind === "dot") {
    const parsed = goParseFloatText(text);
    if (parsed !== null) {
      return { kind: "scalar", scalar: { kind: "float", value: parsed } };
    }
    return { kind: "scalar", scalar: { kind: "str", value: text } };
  }
  const stamp = resolveYamlTimestamp(text);
  if (stamp !== null) {
    return { kind: "scalar", scalar: { kind: "time", value: stamp } };
  }
  const plain = text.replaceAll("_", "");
  const asInt = goParseIntBase0(plain);
  if (asInt !== null) return intScalar(asInt);
  if (YAML_FLOAT.test(plain)) {
    const parsed = goParseFloatText(plain);
    if (parsed !== null) {
      return { kind: "scalar", scalar: { kind: "float", value: parsed } };
    }
  }
  return { kind: "scalar", scalar: { kind: "str", value: text } };
}

/** True when a plain rendering of `text` would not read back as a string. */
export function plainReadsAsString(text: string): boolean {
  try {
    const resolved = resolvePlainScalar(text);
    return resolved.kind === "scalar" && resolved.scalar.kind === "str";
  } catch {
    return false;
  }
}
