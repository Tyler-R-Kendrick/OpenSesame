import { pathToFileURL } from "node:url";
import { isString } from "@opensesame/os-domain";
import { main as mainImpl } from "./index.js";

export const cliSeams = {
  main: mainImpl,
  error: (message: string) => {
    console.error(message);
  },
  exit: (code: number) => {
    process.exit(code);
  },
};

export function runCli(): void {
  cliSeams.main().catch((err) => {
    cliSeams.error(err instanceof Error ? err.message : String(err));
    cliSeams.exit(1);
  });
}

const isMain =
  isString(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli();
}
