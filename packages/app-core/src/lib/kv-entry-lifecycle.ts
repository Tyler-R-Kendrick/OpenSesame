/** Same-realm turns for one physical origin filename, beneath existing authority locks. */
type EntryState = {
  tail: Promise<void>;
  mutation: number;
  forgotten: number;
};
export type OriginFileTurn = {
  publish: (effect: () => void) => boolean;
  clear: (effect: () => void) => void;
  isLive: () => boolean;
};
const entries = new Map<string, EntryState>();
let order = 0;

/** Immediate cache mutations supersede older reads; failed writes mutate no revision. */
export function originMemoryChanged(name: string, forgotten = false): void {
  const state = entries.get(name);
  if (!state) return;
  state.mutation = ++order;
  if (forgotten) state.forgotten = state.mutation;
}

/** Reset invalidates publication, while every active physical turn keeps its place. */
export function originMemoryForgotten(): void {
  for (const name of entries.keys()) originMemoryChanged(name, true);
}

export async function withOriginFile<T>(
  name: string,
  work: (turn: OriginFileTurn) => Promise<T>,
): Promise<T> {
  const state = entries.get(name) ?? {
    tail: Promise.resolve(),
    mutation: 0,
    forgotten: 0,
  };
  entries.set(name, state);
  const ticket = ++order;
  const turn: OriginFileTurn = {
    isLive: () => state.forgotten <= ticket,
    publish(effect) {
      if (state.mutation > ticket) return false;
      effect();
      state.mutation = ticket;
      return true;
    },
    clear(effect) {
      effect();
      state.mutation = Math.max(state.mutation, ticket);
    },
  };
  const result = state.tail.then(() => work(turn));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  state.tail = tail;
  void tail.then(() => {
    if (state.tail === tail) entries.delete(name);
  });
  // Only the private tail absorbs failure. This distinct outer promise still rejects.
  return await result;
}
