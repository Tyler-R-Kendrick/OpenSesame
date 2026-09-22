import type { BoundaryValue } from "@opensesame/os-domain";
import type { CompilerErrorCode } from "./evidence.js";
import { INVALID_FIXTURES_PART_1 } from "./invalid-fixtures/part-1.js";
import { INVALID_FIXTURES_PART_2 } from "./invalid-fixtures/part-2.js";

/** Schema-shaped invalid documents for each compiler error code. */
export const INVALID_FIXTURES = {
  ...INVALID_FIXTURES_PART_1,
  ...INVALID_FIXTURES_PART_2,
} satisfies Record<CompilerErrorCode, BoundaryValue>;
