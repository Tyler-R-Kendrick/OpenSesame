/**
 * Document-level helpers on top of `ObjectReader`: the root entry point and
 * the cross-list disjointness check.
 */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { type Diagnostic, diagnostic, pushDiagnostic } from "./diagnostics.js";
import { isUnitName } from "./ids.js";
import { ObjectReader } from "./parse-fields.js";
import { indexPath } from "./parse-primitives.js";

export type NamedIdList = Readonly<{
  name: string;
  path: string;
  ids: readonly string[];
}>;

/** An id in two of the lists is an error, reported at its later occurrence. */
export function checkDisjoint(
  reader: ObjectReader,
  lists: readonly NamedIdList[],
): void {
  const firstSeen = new Map<string, string>();
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const earlier = firstSeen.get(id);
      if (earlier === undefined) {
        firstSeen.set(id, list.name);
        return;
      }
      reader.report(
        "CONFLICTING_SETS",
        indexPath(list.path, index),
        `\`${id}\` appears in both \`${earlier}\` and \`${list.name}\``,
      );
    });
  }
}

/** Entry point: the document must be a JSON object. */
export function rootReader(
  v: BoundaryValue,
  diags: Diagnostic[],
): ObjectReader | undefined {
  if (!isJsonObject(v)) {
    pushDiagnostic(
      diags,
      diagnostic("NOT_OBJECT", "", "document must be a JSON object"),
    );
    return undefined;
  }
  return new ObjectReader(v, "", diags);
}

export const isSlotName = isUnitName;
