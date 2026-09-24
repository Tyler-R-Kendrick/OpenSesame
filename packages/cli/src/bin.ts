#!/usr/bin/env node
import { runMcp } from "./mcp-commands.js";
import { runCli } from "./run.js";

const argv = process.argv.slice(2);
// An MCP server keeps the process alive on its transport; everything else
// exits with the command's status.
const code =
  argv[0] === "mcp" ? await runMcp(argv.slice(1)) : await runCli(argv);
if (code !== undefined) process.exit(code);
