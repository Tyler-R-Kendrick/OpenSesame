import { reservedReason } from "@opensesame/app-core/lib/keymap/config.js";
import {
  type BindMode,
  bindKey,
  conflictFor,
  restoreKey,
  unbindKey,
} from "@opensesame/app-core/lib/keymap/effective.js";
import { useEffect, useRef, useState } from "react";
import type { KeymapState } from "./useKeymap.js";

export type Editing = { previous?: string };
export type Pending = { sequence: string; holder: string; previous?: string };
/** A refusal is an event: the same message twice is two refusals. */
export type Refusal = { message: string; n: number };

/** `+` is where focus goes when no keycap was made. */
export const ADD_KEY = "+";

/**
 * Recording a key for one target, as a small state machine: idle → capturing
 * → (taken → swap / take / keep) → idle. Every exit hands focus back to the
 * keycap that now exists, or to `+`, unless the person already moved it.
 */
export function useBindFlow(target: string, state: KeymapState) {
  const { config, commands, bindings, save, scope } = state;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<Refusal | null>(null);
  const refusals = useRef(0);
  const refuse = (message: string) => {
    refusals.current += 1;
    setProblem({ message, n: refusals.current });
  };
  const [land, setLand] = useState<string | null>(null);
  const cell = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (land === null) return;
    const made = [
      ...(cell.current?.querySelectorAll<HTMLElement>("[data-sequence]") ?? []),
    ].find((node) => node.dataset.sequence === land);
    const next =
      made ?? cell.current?.querySelector<HTMLElement>("[data-add-key]");
    const active = document.activeElement;
    const idle =
      active === null ||
      active === document.body ||
      cell.current?.contains(active);
    if (idle) next?.focus();
    setLand(null);
  }, [land]);

  const close = (landOn: string) => {
    setEditing(null);
    setPending(null);
    setProblem(null);
    setLand(landOn);
  };

  const apply = (next: typeof config, landOn: string) => {
    const refused = save(next);
    if (refused) refuse(refused);
    else close(landOn);
  };

  const commit = (sequence: string, previous?: string, mode?: BindMode) =>
    apply(
      bindKey(config, commands, sequence, target, {
        previous,
        mode,
        context: scope,
      }),
      sequence,
    );

  const propose = (sequence: string) => {
    const previous = editing?.previous;
    const reserved = reservedReason(sequence);
    if (reserved) {
      refuse(reserved);
      return;
    }
    if (sequence === previous) {
      close(sequence);
      return;
    }
    const conflict = conflictFor(sequence, target, bindings);
    if (conflict.kind !== "taken") {
      commit(sequence, previous);
      return;
    }
    setEditing(null);
    setPending({ sequence, holder: conflict.target, previous });
  };

  return {
    cell,
    editing,
    pending,
    problem,
    start: (previous?: string) => {
      setProblem(null);
      setEditing(previous === undefined ? {} : { previous });
    },
    close,
    commit,
    propose,
    remove: (sequence: string) =>
      apply(unbindKey(config, commands, sequence, scope), ADD_KEY),
    /**
     * Bring a struck key back where the table is looking: a strike made in
     * this scope is forgotten; one made everywhere is undone here only.
     */
    restore: (sequence: string, struckHere: boolean) =>
      apply(
        struckHere || scope === undefined
          ? restoreKey(config, sequence, scope)
          : bindKey(config, commands, sequence, target, { context: scope }),
        sequence,
      ),
  };
}
