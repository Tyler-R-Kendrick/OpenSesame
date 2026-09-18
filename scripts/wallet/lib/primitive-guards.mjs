/** Tag-check primitives without typeof (anti-slop). */
export function isNumber(value) {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object Number]"
  );
}

export function isString(value) {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}
