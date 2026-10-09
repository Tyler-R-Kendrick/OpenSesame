/** Public generated metadata retains every byte while sharing repeated fragments. */
export function unpackGeneratedJson(
  text: string,
  dictionary: readonly string[],
): string {
  return text.replace(/~([0-9a-f]+)~/g, (_match, index: string) => {
    const value = dictionary[Number.parseInt(index, 16)];
    if (value === undefined) throw new Error("Invalid generated JSON fragment");
    return value;
  });
}
