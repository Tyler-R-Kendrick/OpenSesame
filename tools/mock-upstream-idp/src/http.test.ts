import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  autoSubmitFormHtml,
  escapeHtml,
  securityHeaders,
  sendHtml,
  sendJson,
} from "./http.js";

// Response hygiene for reflected values: JSON answers can never be
// reinterpreted as HTML, and the self-posting HTML forms escape every
// reflected value and ship a no-load policy.

/** What a handler wrote to the stand-in response. */
type CapturedResponse = {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
};

function fakeResponse() {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: "",
  };
  const res = {
    writeHead(status: number, headers: OutgoingHttpHeaders) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  const response: ServerResponse = overlapCast(res);
  return { res: response, captured };
}

function header(captured: CapturedResponse, name: string): string {
  return String(captured.headers[name] ?? "");
}

describe("http response hygiene", () => {
  it("escapes HTML metacharacters in reflected values", () => {
    expect(escapeHtml(`<script>"'&</script>`)).toBe(
      "&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;",
    );
  });

  it("escapes reflected fields and the form action", () => {
    const html = autoSubmitFormHtml(
      `https://rp.example/cb?x="><script>`,
      [{ name: "state", value: `"><svg onload=alert(1)>` }],
      "continue",
    );
    expect(html).not.toContain("<script>>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
  });

  it("pins nosniff so caller overrides cannot weaken it", () => {
    const headers = securityHeaders({
      "content-type": "text/html",
    });
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("never lets a JSON answer go out as HTML", () => {
    const { res, captured } = fakeResponse();
    sendJson(res, 400, { error: "<script>alert(1)</script>" }, "", {
      "content-type": "text/html",
    });
    expect(header(captured, "content-type")).toBe("application/json");
    expect(header(captured, "x-content-type-options")).toBe("nosniff");
    expect(JSON.parse(captured.body).error).toBe("<script>alert(1)</script>");
  });

  it("ships HTML forms under a no-load content security policy", () => {
    const { res, captured } = fakeResponse();
    sendHtml(res, 200, "<!DOCTYPE html><title>x</title>");
    expect(header(captured, "content-type")).toContain("text/html");
    expect(header(captured, "content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(header(captured, "x-content-type-options")).toBe("nosniff");
  });
});
