import {
  listLocalGrants,
  subscribeAccessBook,
} from "@opensesame/app-core/lib/access-book.js";
import { useSyncExternalStore } from "react";

/**
 * Whether the access book holds a grant, live. Access › Grants draws its
 * Portable grants panel only then, and the rail lists it by the same answer.
 */
export function useHasPortableGrants(): boolean {
  return useSyncExternalStore(
    subscribeAccessBook,
    () => listLocalGrants().length > 0,
  );
}
