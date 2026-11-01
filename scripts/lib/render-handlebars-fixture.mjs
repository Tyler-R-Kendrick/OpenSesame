#!/usr/bin/env node
import Handlebars from "handlebars";
import { readFileSync } from "node:fs";

/**
 * Render a Handlebars template file with the given context. Used for conformance
 * fixtures whose secret-shaped fields must not live in git as literals.
 */
export function renderHandlebarsTemplate(templatePath, context) {
  const source = readFileSync(templatePath, "utf8");
  const render = Handlebars.compile(source, {
    strict: true,
    noEscape: true,
  });
  return render(context);
}

/**
 * Parse a JSON Handlebars template after rendering.
 */
export function renderHandlebarsJson(templatePath, context) {
  return JSON.parse(renderHandlebarsTemplate(templatePath, context));
}
