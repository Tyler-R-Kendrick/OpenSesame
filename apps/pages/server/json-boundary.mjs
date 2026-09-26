/**
 * The relay's I/O-boundary checks: request bodies and upstream replies are
 * parsed here, once, before any handler branches on them. The same contract
 * as `@opensesame/os-domain`'s `json.ts`, which this Node code cannot import
 * (that package publishes TypeScript source).
 */

function hasPrimitiveTag(value, tag) {
  return (
    Object(value) !== value && Object.prototype.toString.call(value) === tag
  );
}

export function isString(value) {
  return hasPrimitiveTag(value, "[object String]");
}

export function isNumber(value) {
  return hasPrimitiveTag(value, "[object Number]");
}

export function isFunction(value) {
  return (
    Object.prototype.toString.call(value) === "[object Function]" ||
    Object.prototype.toString.call(value) === "[object AsyncFunction]"
  );
}

/** A plain JSON object: not null, not an array, not a function. */
export function isJsonObject(value) {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !isFunction(value)
  );
}

/** A JSON object field, or `{}` when the value is not one. */
export function objectOr(value) {
  return isJsonObject(value) ? value : {};
}

/** A string field, or `undefined` when the value is not one. */
export function readString(value) {
  return isString(value) ? value : undefined;
}
