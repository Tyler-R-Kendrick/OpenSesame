import { defineTool } from "eve/tools";
import { z } from "zod";

import { runDeepsec } from "../lib/deepsec";

export default defineTool({
  description:
    "Export existing Deepsec findings to .deepsec/findings (markdown). Does not run AI process.",
  inputSchema: z.object({}),
  async execute() {
    return runDeepsec([
      "export",
      "--project-id",
      "opensesame",
      "--format",
      "md-dir",
      "--out",
      "./findings",
    ]);
  },
});
