/**
 * A bounded, backtracking-free matcher for the Go/RE2 subset SOPS
 * selectors use (B09, SB-046).
 *
 * Go's `regexp` is a Thompson NFA simulation: linear in the input and
 * immune to catastrophic backtracking. JavaScript's `RegExp` is a
 * backtracking engine, so `(a|aa)*$` against a non-matching string is
 * exponential there and linear in Go. Sniffing for "dangerous-looking"
 * patterns cannot close that gap — `(a+)+` is easy to spot, `(a|aa)*` is
 * not — so this module compiles the accepted subset (see `re2-parse.ts`)
 * to an NFA and simulates it the way Go does, under explicit program and
 * step budgets. Patterns that would hang a backtracking engine are
 * therefore answered, not rejected.
 *
 * Semantics match `regexp.MatchString`: an unanchored search over the
 * whole text, with `^` and `$` bound to the start and end of the text
 * (RE2 has no multiline mode unless asked, and SOPS never asks).
 */

import { SopsError } from "./errors.js";
import { type Node, type Pred, parsePattern } from "./re2-parse.js";

const MAX_PROGRAM = 4000;
const MAX_STEPS = 2_000_000;

type Inst =
  | { op: "char"; test: Pred }
  | { op: "split"; a: number; b: number }
  | { op: "jmp"; to: number }
  | { op: "assert"; at: "start" | "end" }
  | { op: "match" };

class Program {
  readonly insts: Inst[] = [];

  push(inst: Inst): number {
    if (this.insts.length >= MAX_PROGRAM) {
      throw new SopsError(
        "resource_limit",
        "A regex compiles to too many states.",
      );
    }
    this.insts.push(inst);
    return this.insts.length - 1;
  }
}

/** Patch a `split`'s branch targets once the emitted code is in place. */
function patchSplit(
  program: Program,
  at: number,
  branch: "a" | "b",
  target: number,
): void {
  const current = program.insts[at];
  if (current?.op === "split")
    program.insts[at] = { ...current, [branch]: target };
}

function emitAlt(program: Program, items: readonly Node[]): void {
  const jumps: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? { kind: "empty" as const };
    if (index === items.length - 1) {
      emit(program, item);
      break;
    }
    const split = program.push({ op: "split", a: 0, b: 0 });
    patchSplit(program, split, "a", program.insts.length);
    emit(program, item);
    jumps.push(program.push({ op: "jmp", to: 0 }));
    patchSplit(program, split, "b", program.insts.length);
  }
  for (const jump of jumps)
    program.insts[jump] = { op: "jmp", to: program.insts.length };
}

function emitRepeat(
  program: Program,
  node: Extract<Node, { kind: "repeat" }>,
): void {
  for (let count = 0; count < node.min; count += 1) emit(program, node.item);
  if (node.max === null) {
    const split = program.push({ op: "split", a: 0, b: 0 });
    patchSplit(program, split, "a", program.insts.length);
    emit(program, node.item);
    program.push({ op: "jmp", to: split });
    patchSplit(program, split, "b", program.insts.length);
    return;
  }
  const splits: number[] = [];
  for (let count = node.min; count < node.max; count += 1) {
    const split = program.push({ op: "split", a: 0, b: 0 });
    patchSplit(program, split, "a", program.insts.length);
    splits.push(split);
    emit(program, node.item);
  }
  for (const split of splits)
    patchSplit(program, split, "b", program.insts.length);
}

function emit(program: Program, node: Node): void {
  switch (node.kind) {
    case "empty":
      return;
    case "char":
      program.push({ op: "char", test: node.test });
      return;
    case "assert":
      program.push({ op: "assert", at: node.at });
      return;
    case "cat":
      for (const item of node.items) emit(program, item);
      return;
    case "alt":
      emitAlt(program, node.items);
      return;
    case "repeat":
      emitRepeat(program, node);
      return;
    default: {
      // Exhaustiveness: every node kind is handled above.
      const unreachable: never = node;
      void unreachable;
      return;
    }
  }
}

export type CompiledRe2 = { insts: Inst[] };

export function compile(pattern: string): CompiledRe2 {
  const program = new Program();
  emit(program, parsePattern(pattern));
  program.push({ op: "match" });
  return { insts: program.insts };
}

/**
 * Thompson simulation: one pass over the text, each instruction visited at
 * most once per position, so the work is bounded by `text × program`.
 */
export function matches(compiled: CompiledRe2, text: string): boolean {
  const codes = [...text].map((char) => char.codePointAt(0) ?? 0);
  const insts = compiled.insts;
  const onList = new Int32Array(insts.length).fill(-1);
  let steps = 0;
  let current: number[] = [];
  let next: number[] = [];

  const add = (list: number[], pc: number, position: number): void => {
    steps += 1;
    if (steps > MAX_STEPS) {
      throw new SopsError(
        "resource_limit",
        "A regex exceeded its execution budget.",
      );
    }
    if (onList[pc] === position) return;
    onList[pc] = position;
    const inst = insts[pc];
    if (!inst) return;
    if (inst.op === "jmp") {
      add(list, inst.to, position);
      return;
    }
    if (inst.op === "split") {
      add(list, inst.a, position);
      add(list, inst.b, position);
      return;
    }
    if (inst.op === "assert") {
      const held =
        inst.at === "start" ? position === 0 : position === codes.length;
      if (held) add(list, pc + 1, position);
      return;
    }
    list.push(pc);
  };

  for (let position = 0; position <= codes.length; position += 1) {
    // An unanchored search: every position is a possible start.
    add(current, 0, position);
    for (const pc of current) {
      const inst = insts[pc];
      if (!inst) continue;
      if (inst.op === "match") return true;
      if (
        inst.op === "char" &&
        position < codes.length &&
        inst.test(codes[position] ?? -1)
      ) {
        add(next, pc + 1, position + 1);
      }
    }
    current = next;
    next = [];
  }
  for (const pc of current) if (insts[pc]?.op === "match") return true;
  return false;
}
