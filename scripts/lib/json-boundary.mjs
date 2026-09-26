/**
 * I/O-boundary checks for the Node scripts: a fetched or read JSON value is
 * parsed here before anything branches on it. The same contract as
 * `@opensesame/os-domain`'s `json.ts`, which plain Node cannot import (that
 * package publishes TypeScript source).
 */

function hasPrimitiveTag(value, tag) {
  return (
    Object(value) !== value && Object.prototype.toString.call(value) === tag
  );
}

export function isString(value) {
  return hasPrimitiveTag(value, "[object String]");
}

/** A plain JSON object: not null, not an array, not a function. */
export function isJsonObject(value) {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !Object.prototype.toString.call(value).endsWith("Function]")
  );
}

/** A string field, or `undefined` when the value is not one. */
export function readString(value) {
  return isString(value) ? value : undefined;
}
