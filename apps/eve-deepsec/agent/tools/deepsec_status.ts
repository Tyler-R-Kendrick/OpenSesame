import { defineTool } from "eve/tools";
import { z } from "zod";

import { runDeepsec } from "../lib/deepsec";

export default defineTool({
  description: "Show Deepsec project status (analyzed/pending counts and finding totals).",
  inputSchema: z.object({}),
  async execute() {
    return runDeepsec(["status", "--project-id", "opensesame"]);
  },
});
