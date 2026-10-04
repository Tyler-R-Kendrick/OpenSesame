import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "@opensesame/app-core/lib/local-iam-events.js";
import { useEffect, useState } from "react";

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * The names this vault's directory gives the applications and people a
 * receipt points at, by id. A receipt stores ids only (ADR 0162); the name is
 * read here, from the same sealed directory, when it is shown. Empty until it
 * is read, and when the directory cannot be: the receipt then shows its id.
 */
export function useReceiptNames(
  tomb: string,
  enabled: boolean,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(NONE);
  useEffect(() => {
    if (!enabled) {
      setNames(NONE);
      return;
    }
    let live = true;
    const read = () => {
      readLocalDirectory(tomb).then(
        (directory) => {
          if (live)
            setNames(new Map(directory.entries.map((e) => [e.id, e.name])));
        },
        () => {
          if (live) setNames(NONE);
        },
      );
    };
    read();
    const offHere = subscribeLocalIamChanges(read);
    const offThere = subscribeLocalIamChangesFromOtherTabs(read);
    return () => {
      live = false;
      offHere();
      offThere();
    };
  }, [tomb, enabled]);
  return names;
}
