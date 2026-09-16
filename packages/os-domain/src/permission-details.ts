/**
 * RFC 9396 `authorization_details` as the correlated wire form.
 *
 * The RFC already got this right: an element carries its own `actions` **and**
 * its own `locations`, so a request for "read A" and "write B" is two elements
 * and never four pairs. The loss happened on the way in, when a list of
 * elements was unioned into two flat fields before anything enforced it.
 * Keeping the elements means the prompt a person reads, the digest an approval
 * binds to, and the predicate the host checks are one object.
 *
 * Conversion is strict rather than forgiving: an element with actions and no
 * locations is refused instead of read as "anywhere". A resource scope that
 * was decorative because nobody said what it was is the whole failure mode
 * being fixed here.
 */

import type { AuthorizationDetail } from "./authorization-details.js";
import { type JsonValue, isString } from "./json.js";
import {
  MAX_SET_ENTRIES,
  type PermissionSet,
  entryResourcePatterns,
  permissionEntry,
  permissionSet,
} from "./permission-entry.js";
import { refuse } from "./permission-scope.js";

function stringArray(
  value: JsonValue | undefined,
  index: number,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    refuse(`authorization_details[${index}]`, `has no ${field} array`);
  }
  return value.map((item) => {
    if (!isString(item)) {
      refuse(
        `authorization_details[${index}]`,
        `${field} carries a non-string`,
      );
    }
    return item;
  });
}

/**
 * Read correlated authority out of an `authorization_details` array.
 *
 * One element, one entry — never a union of the elements. `identifier` joins
 * `locations` because RFC 9396 defines it as a resource name, not as a second
 * axis; treating it as one would be two lists again.
 */
export function permissionSetFromAuthorizationDetails(
  details: readonly AuthorizationDetail[],
): PermissionSet {
  if (details.length === 0) refuse("authorization_details", "is empty");
  if (details.length > MAX_SET_ENTRIES) {
    refuse(
      "authorization_details",
      `carries more than ${MAX_SET_ENTRIES} elements`,
    );
  }
  return permissionSet(
    details.map((detail, index) => {
      if (!isString(detail.type) || detail.type.length === 0) {
        refuse(`authorization_details[${index}]`, "has no type");
      }
      const actions = stringArray(detail.actions, index, "actions");
      const locations = stringArray(detail.locations, index, "locations");
      const identifier = detail.identifier;
      if (identifier !== undefined) {
        if (!isString(identifier)) {
          refuse(
            `authorization_details[${index}]`,
            "identifier is not a string",
          );
        }
        locations.push(identifier);
      }
      return permissionEntry(actions, locations);
    }),
  );
}

/**
 * Render correlated authority back to `authorization_details`, one element per
 * entry, under a single detail type.
 */
export function authorizationDetailsFromPermissionSet(
  set: PermissionSet,
  detailType: string,
): AuthorizationDetail[] {
  return set.entries.map((entry) => ({
    type: detailType,
    actions: [...entry.actions],
    locations: entryResourcePatterns(entry),
  }));
}
