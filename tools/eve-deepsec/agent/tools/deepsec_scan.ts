import { defineTool } from "eve/tools";
import { z } from "zod";

import { runDeepsec } from "../lib/deepsec";

export default defineTool({
  description:
    "Run the Deepsec pattern scan on OpenSesame (no AI process). Use before triaging candidates.",
  inputSchema: z.object({}),
  async execute() {
    const result = await runDeepsec(["scan", "--project-id", "opensesame"]);
    return result;
  },
});
