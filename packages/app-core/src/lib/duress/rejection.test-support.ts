/**
 * The error an attempt was refused with, for suites that assert on the refusal.
 *
 * A rejection is read, not assumed: an attempt that resolves, or that rejects
 * with something that is not an `Error`, fails the test where it happens.
 */
export async function rejectionOf<T>(attempt: Promise<T>): Promise<Error> {
  try {
    await attempt;
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new TypeError(
      "the attempt rejected with a value that is not an Error",
    );
  }
  throw new Error("the attempt resolved; a refusal was expected");
}
