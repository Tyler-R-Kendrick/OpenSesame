#!/usr/bin/env node
/**
 * Parse .env.schema via official @env-spec/parser; emit JSON for OpenSesame Rust.
 * Never prints resolved secret plaintext — only schema AST + resolver references.
 */
import { readFileSync } from "node:fs";
import { parseEnvSpecDotEnvFile } from "@env-spec/parser";

function decValue(v) {
  if (v == null) return true;
  if (v.constructor?.name === "ParsedEnvSpecStaticValue") {
    return v.value ?? v.data?.rawValue ?? null;
  }
  if (v.constructor?.name === "ParsedEnvSpecFunctionCall") {
    return {
      fn: v.data.name,
      args: funcArgs(v.data.args),
    };
  }
  return v;
}

function funcArgs(args) {
  if (!args?.data?.values) return [];
  return args.data.values.map((a) => {
    if (a.constructor?.name === "ParsedEnvSpecKeyValuePair") {
      return {
        key: a.data.key,
        value: decValue(a.data.val ?? a.val),
      };
    }
    if (a.constructor?.name === "ParsedEnvSpecStaticValue") {
      return { value: a.value ?? a.data?.rawValue };
    }
    return { value: String(a) };
  });
}

function decoratorsFromComments(comments) {
  const out = [];
  for (const c of comments || []) {
    const decs = c.data?.decorators || [];
    for (const d of decs) {
      out.push({
        name: d.data?.name,
        value: decValue(d.data?.value),
      });
    }
  }
  return out;
}

function itemToJson(item) {
  const key = item.data.key;
  const decorators = decoratorsFromComments(item.data.preComments);
  if (item.data.postComment?.data?.decorators) {
    decorators.push(...decoratorsFromComments([item.data.postComment]));
  }
  const sensitive = decorators.some(
    (d) => d.name === "sensitive" && d.value !== false,
  );
  const required = decorators.some(
    (d) => d.name === "required" && d.value !== false,
  );
  const isPublic = decorators.some(
    (d) => d.name === "public" && d.value !== false,
  );
  let value = null;
  let resolver = null;
  const v = item.value;
  if (v?.constructor?.name === "ParsedEnvSpecStaticValue") {
    value = v.value ?? v.data?.rawValue ?? null;
  } else if (v?.constructor?.name === "ParsedEnvSpecFunctionCall") {
    resolver = {
      fn: v.data.name,
      args: funcArgs(v.data.args),
    };
  }
  const typeDec = decorators.find((d) => d.name === "type");
  return {
    key,
    sensitive,
    required,
    public: isPublic,
    type: typeDec?.value ?? null,
    value: sensitive ? null : value,
    resolver,
    decorators,
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: opensesame-env-parse <path-to-.env.schema>");
    process.exit(2);
  }
  const src = readFileSync(file, "utf8");
  const doc = parseEnvSpecDotEnvFile(src);
  const items = [];
  for (const el of doc.contents || []) {
    if (el.constructor?.name === "ParsedEnvSpecConfigItem") {
      items.push(itemToJson(el));
    }
  }
  const out = {
    schema_path: file,
    parser: "@env-spec/parser",
    items,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
