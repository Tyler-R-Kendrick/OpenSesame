/**
 * Durable checks for the grok hard-kill timeout contract.
 * Run: node --experimental-strip-types --test .deepsec/grok-agent-prompt.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC = "";
process.env.DEEPSEC_GROK_FILE_WALL_SEC = "";
process.env.DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC = "";
process.env.DEEPSEC_GROK_DEEP_TIMEOUT_SEC = "";

// The .deepsec sources import siblings as "./x.js" (deepsec loader
// convention); rewrite to the .ts source so plain Node can load them.
const { register } = await import("node:module");
register(
  "data:text/javascript,export async function resolve(s,c,next){" +
    "if(s.endsWith('.js')){try{return await next(s.replace(/\\.js$/,'.ts'),c);}catch{}}" +
    "return next(s,c);}",
);

const {
  detectGrokCapHit,
  grokDeepTimeoutSec,
  grokEnv,
  grokFileWallSec,
  grokInvestigateTimeoutSec,
  grokKillGraceMs,
  grokShallowTimeoutSec,
} = await import("./grok-agent-prompt.ts");

test("grokEnv strips pay-per-token keys so Grok Build subscription is used", () => {
  process.env.XAI_API_KEY = "must-not-reach-grok-child";
  process.env.GROK_CODE_XAI_API_KEY = "must-not-reach-grok-child";
  process.env.GROK_DEPLOYMENT_KEY = "must-not-reach-grok-child";
  const env = grokEnv();
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(env.GROK_DEPLOYMENT_KEY, undefined);
  Reflect.deleteProperty(process.env, "XAI_API_KEY");
  Reflect.deleteProperty(process.env, "GROK_CODE_XAI_API_KEY");
  Reflect.deleteProperty(process.env, "GROK_DEPLOYMENT_KEY");
});

test("defaults align invoke timeout with the 2700s file wall", () => {
  assert.equal(grokFileWallSec(), 2700);
  assert.equal(grokInvestigateTimeoutSec(), 2700);
});

test("shallow + deep budgets fit inside the file wall with headroom", () => {
  const shallow = grokShallowTimeoutSec();
  const deep = grokDeepTimeoutSec();
  assert.ok(shallow > 0 && shallow <= 600);
  assert.ok(deep >= 300);
  assert.ok(shallow + deep <= grokFileWallSec());
});

test("cap detection flags turn-limit text and turn counts", () => {
  assert.equal(detectGrokCapHit("exceeded max turns", "", 60), true);
  assert.equal(
    detectGrokCapHit("", JSON.stringify({ num_turns: 60 }), 60),
    true,
  );
  assert.equal(
    detectGrokCapHit("", JSON.stringify({ num_turns: 3 }), 60),
    false,
  );
  assert.equal(detectGrokCapHit("", "plain answer", 60), false);
});

test("kill grace falls back instead of yielding NaN or a negative delay", () => {
  process.env.DEEPSEC_GROK_KILL_GRACE_MS = "";
  assert.equal(grokKillGraceMs(), 10000);
  process.env.DEEPSEC_GROK_KILL_GRACE_MS = "2500";
  assert.equal(grokKillGraceMs(), 2500);
  process.env.DEEPSEC_GROK_KILL_GRACE_MS = "nope";
  assert.equal(grokKillGraceMs(), 10000);
  process.env.DEEPSEC_GROK_KILL_GRACE_MS = "-5";
  assert.equal(grokKillGraceMs(), 10000);
  process.env.DEEPSEC_GROK_KILL_GRACE_MS = "";
});

test("env overrides are honored and invalid values fall back", () => {
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "120";
  assert.equal(grokFileWallSec(), 120);
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "nope";
  assert.equal(grokFileWallSec(), 2700);
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "2700";
});
