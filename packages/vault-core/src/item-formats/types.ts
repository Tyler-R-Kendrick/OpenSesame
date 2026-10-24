/** The closed shape every per-item-type parser/generator pair implements. */
import type { FieldValues } from "@opensesame/vault-item-types";
import type { Random } from "./random.js";

export type ItemFormatContext = {
  readonly random: Random;
  readonly now: Date;
};

/**
 * A format is an algorithm over one canonical value. `parse` proves a value is
 * well formed and returns the fields it can recover; `generate` makes a
 * synthetic value that parses again. Neither touches a provider.
 */
export type ItemFormat = {
  readonly id: string;
  readonly typeId: string;
  readonly label: string;
  /** Higher wins detection; equal specificity keeps registry order. */
  readonly specificity: number;
  parse(value: string): FieldValues | null;
  /** Absent when no synthetic value can be honest (a CA-issued certificate). */
  generate?: (context: ItemFormatContext) => FieldValues;
  /** The value `parse` should receive after `generate`, when recoverable. */
  canonical?: (values: FieldValues) => string | null;
};

export type ItemFormatMatch = {
  readonly formatId: string;
  readonly typeId: string;
  readonly label: string;
  readonly specificity: number;
  readonly values: FieldValues;
  /** The exact value that matched, not a normalised rewrite. */
  readonly canonical: string;
};

export type GeneratedItemFormat = Omit<ItemFormatMatch, "canonical"> & {
  readonly canonical: string | null;
};

export type GenerateItemFormatOptions = {
  readonly formatId?: string;
  readonly random?: Random;
  readonly now?: Date;
};
