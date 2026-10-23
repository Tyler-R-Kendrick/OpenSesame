/** Decode text at a JSON boundary without coercing numbers, arrays or objects. */
export function decodeJsonText(value, label) {
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    throw new Error(label);
  }
}
