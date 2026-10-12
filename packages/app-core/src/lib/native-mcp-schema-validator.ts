/** Keep SDK input and output validation under the same preflight and work budget. */
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { nativeMcpJsonBudget } from "./native-mcp-schema-budget.js";
import { nativeMcpSchemaCost } from "./native-mcp-schema-guard.js";
import { NativeMcpError } from "./native-mcp-target.js";

export class NativeMcpSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    // SAFETY: SDK JsonSchemaType is the object JSON-schema contract; the preflight validates its complete graph before use.
    const cost = nativeMcpSchemaCost(schema as JsonObject);
    // The underlying library adds private nonenumerable reference annotations.
    // Clone only after bounds are checked; leave the actual advertised guide intact.
    const copy: JsonSchemaType = JSON.parse(JSON.stringify(schema));
    const validate = new CfWorkerJsonSchemaValidator().getValidator<T>(copy);
    return (input) => {
      // SAFETY: this boundary is scanned iteratively and bounded before the interpreter sees SDK-provided JSON input.
      if (cost * nativeMcpJsonBudget(input as BoundaryValue) > 250_000)
        throw new NativeMcpError("schema-limits");
      return validate(input);
    };
  }
}
