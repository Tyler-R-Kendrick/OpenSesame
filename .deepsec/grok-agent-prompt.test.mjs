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
  capInvokeTimeoutToFileWall,
  detectGrokCapHit,
  grokDeepTimeoutSec,
  grokFileWallSec,
  grokInvestigateTimeoutSec,
  grokInvokeHardCapMs,
  grokShallowTimeoutSec,
  grokWallRemainingSec,
} = await import("./grok-agent-prompt.ts");

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

test("capInvokeTimeoutToFileWall shrinks invoke budget as the wall elapses", () => {
  const ctx = { startedAtMs: Date.now() - 2500 * 1000, wallSec: 2700 };
  assert.equal(grokWallRemainingSec(ctx), 200);
  assert.equal(capInvokeTimeoutToFileWall(600, ctx, 30), 170);
  const expired = { startedAtMs: Date.now() - 4000 * 1000, wallSec: 2700 };
  assert.throws(
    () => capInvokeTimeoutToFileWall(600, expired, 30),
    /DEEPSEC_GROK_FILE_WALL_SEC/,
  );
});

test("grokInvokeHardCapMs is bounded by remaining file wall", () => {
  const ctx = { startedAtMs: Date.now() - 1000 * 1000, wallSec: 1050 };
  const cap = grokInvokeHardCapMs(420, 10_000, ctx);
  assert.ok(cap < 70_000, `expected wall-bound cap, got ${cap}`);
  assert.ok(cap > 10_000);
  const noWall = grokInvokeHardCapMs(420, 10_000);
  assert.equal(noWall, 420 * 1000 + 10_000 + 5000);
});

test("env overrides are honored and invalid values fall back", () => {
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "120";
  assert.equal(grokFileWallSec(), 120);
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "nope";
  assert.equal(grokFileWallSec(), 2700);
  process.env.DEEPSEC_GROK_FILE_WALL_SEC = "2700";
});
