/** Shared argument consumption for CLI command parsers. */
export function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

export function leftover(args: readonly string[], verb: string): void {
  const extra = args[0];
  if (extra !== undefined) {
    throw new Error(`vault ${verb} does not take ${extra}`);
  }
}
