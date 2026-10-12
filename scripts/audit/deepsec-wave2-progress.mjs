#!/usr/bin/env node
import {
  DEFAULT_AGENT,
  DEFAULT_MARKER,
  countWaveCompletion,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));
const agentType = process.argv[4] ?? DEFAULT_AGENT;
const payload = countWaveCompletion(repoRoot, marker, agentType);
console.log(JSON.stringify(payload));
process.exit(payload.filesComplete >= payload.filesTracked ? 0 : 2);
