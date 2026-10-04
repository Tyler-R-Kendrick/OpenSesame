/**
 * The closed set of semantic notes an `observed` outcome may carry. The note
 * says why the trajectory stopped; it is written here, never by a model, so
 * the support layer can branch on it without parsing prose.
 */
export const GUIDE_RUNTIME_NOTES = {
  /** Ran off the end of the trajectory — the replan boundary. */
  exhausted: "trajectory exhausted",
  waitSatisfied: "wait satisfied",
  /** A wait port rejected outside a cancellation: nothing left to observe. */
  unobservable: "wait unobservable",
} as const;
