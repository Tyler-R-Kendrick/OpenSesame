#!/usr/bin/env node
/** Best-effort kill of the active grok subprocess tree after a slice ends or is watchdogged. */
import { register } from "node:module";
register(
  "data:text/javascript,export async function resolve(s,c,next){" +
    "if(s.endsWith('.js')){try{return await next(s.replace(/\\.js$/,'.ts'),c);}catch{}}" +
    "return next(s,c);}",
);
const { killActiveGrokChild, killOrphanDeepsecGrokInvokes } = await import(
  new URL("../../.deepsec/grok-agent-prompt.ts", import.meta.url).href
);
killActiveGrokChild();
const orphans = killOrphanDeepsecGrokInvokes();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ orphans })}\n`);
}
