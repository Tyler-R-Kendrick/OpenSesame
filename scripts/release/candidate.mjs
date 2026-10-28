#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isString } from "../lib/json-boundary.mjs";
import { COMMANDS, COMMAND_OPTIONS } from "./lib/candidate-commands.mjs";
import { envelopeFromEnv } from "./lib/candidate-model.mjs";
import { context, demand } from "./lib/candidate-policy.mjs";
import { Candidates } from "./lib/candidate-service.mjs";

function argumentsOf(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    demand(
      /^--[a-z-]+$/.test(key) && !(key in options),
      "Invalid or repeated command option",
    );
    if (key === "--reuse-complete") options[key] = true;
    else {
      demand(
        index + 1 < rest.length && !rest[index + 1].startsWith("--"),
        `Missing value for ${key}`,
      );
      options[key] = rest[++index];
    }
  }
  return { command, options };
}

export async function outputs(values, path) {
  const lines = [];
  for (const [key, raw] of Object.entries(values)) {
    const value = isString(raw) ? raw : JSON.stringify(raw);
    demand(
      /^[a-z_][a-z0-9_]*$/.test(key) &&
        !/[\r\n]/.test(key) &&
        !/[\r\n]/.test(value),
      "Unsafe GitHub output",
    );
    lines.push(`${key}=${value}\n`);
  }
  if (path) await appendFile(path, lines.join(""));
  else process.stdout.write(lines.join(""));
}

function environmentJson(env, name, required = true) {
  demand(/^[A-Z][A-Z0-9_]*$/.test(name), "Invalid environment variable name");
  if (!env[name] && !required) return undefined;
  demand(
    env[name] && env[name].length < 1024 * 1024,
    `Missing or oversized ${name}`,
  );
  return JSON.parse(env[name]);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = argumentsOf(argv);
  demand(Object.hasOwn(COMMANDS, command), "Unknown candidate command");
  for (const option of Object.keys(options)) {
    demand(
      COMMAND_OPTIONS[command].includes(option),
      `Unsupported option: ${option}`,
    );
  }
  const ctx = context(env, { requireToken: command !== "receipt-envelope" });
  const service = new Candidates(ctx);
  const directory = () => {
    demand(options["--directory"], "--directory is required");
    return resolve(options["--directory"]);
  };
  await COMMANDS[command]({
    ctx,
    service,
    options,
    directory,
    candidate: () => envelopeFromEnv(env),
    output: (values) =>
      outputs(values, options["--output"] || env.GITHUB_OUTPUT),
    environmentJson: (name, required = true) =>
      environmentJson(env, name, required),
    summary: (selected, title) => summary(env, selected, title),
  });
}

async function summary(env, selected, title) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `## ${title}\n\nSource: \`${selected.source_sha}\`\n\n` +
      `Selection cutoff: ${selected.selection_cutoff}. Captured main: \`${selected.selected_main_sha}\`.\n\n` +
      `Newer main excluded by incomplete or failed prerequisites: ${selected.excluded_newer_main}.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`candidate: ${error.message}`);
    process.exitCode = 1;
  });
}
