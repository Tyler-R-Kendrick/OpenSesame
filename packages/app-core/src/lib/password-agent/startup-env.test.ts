import { expect, it, vi } from "vitest";
import { run, runFile } from "./env.js";
import { passwordAgentPolicy } from "./policy.js";
import { validateRunTemplate } from "./startup-env.js";
it("rejects every shared startup variable before provider assignment or template execution", async () => {
  const execute = vi.fn(async () => 0);
  const port = {
    invoke: vi.fn(async () => ""),
    run: execute,
    runEnvFile: execute,
  };
  for (const name of passwordAgentPolicy.credentialStartupEnvKeys) {
    await expect(
      run(port, [{ name, reference: "op://vault/item/field" }], ["node"]),
    ).rejects.toThrow("startup");
    for (const line of [
      `${name}=literal`,
      `export ${name.toLowerCase()} = 'literal'`,
      `"${name}"=literal`,
      `${name}: literal`,
    ])
      await expect(runFile(port, "source.env", ["node"], line)).rejects.toThrow(
        "startup",
      );
  }
  expect(execute).not.toHaveBeenCalled();
  expect(port.invoke).not.toHaveBeenCalled();
});
it("preserves ordinary export quoted comments and multiline literal template semantics", () => {
  expect(() =>
    validateRunTemplate(
      '# NODE_OPTIONS=comment\nexport API="op://vault/item/field"\nPLAIN=ordinary\nTEXT="first\nLD_PRELOAD=literal text\nlast"\n',
    ),
  ).not.toThrow();
});
it("does not let escaped closing delimiters hide a later startup assignment", () => {
  for (const quote of ["'", '"', "`"]) {
    expect(() =>
      validateRunTemplate(
        `TEXT=${quote}value\\${quote}\nNODE_OPTIONS=--require attacker.cjs\n`,
      ),
    ).toThrow("startup");
  }
});

it("rejects unsupported multiline backticks instead of hiding later startup assignments", () => {
  expect(() =>
    validateRunTemplate(
      "TEXT=`unterminated\nNODE_OPTIONS=--require attacker.cjs\n",
    ),
  ).toThrow("startup");
});

it("screens bare CR separators before provider dotenv parsing", () => {
  expect(() =>
    validateRunTemplate("API=ordinary\rNODE_OPTIONS=--require attacker.cjs\r"),
  ).toThrow("startup");
});

it("rejects colon assignments without whitespace after the separator", () => {
  expect(() => validateRunTemplate("LD_PRELOAD:private-hook")).toThrow(
    "startup",
  );
  expect(() =>
    validateRunTemplate("NODE_OPTIONS:--require attacker.cjs"),
  ).toThrow("startup");
});

it("rejects every provider dialect the shared policy names", () => {
  for (const key of passwordAgentPolicy.credentialStartupEnvKeys) {
    for (const line of [
      `${key}=private-hook`,
      `export\t${key} = 'private-hook'`,
      `\uFEFF${key}: private-hook`,
      `"${key}"=private-hook`,
      `\`${key}\`=private-hook`,
      `${key}:private-hook`,
    ])
      expect(() => validateRunTemplate(line)).toThrow("startup");
  }
});
