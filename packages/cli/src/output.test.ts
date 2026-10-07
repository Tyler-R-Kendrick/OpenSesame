import { dropLink } from "@opensesame/app-core/lib/vault/drop.js";
import { overlapCast } from "@opensesame/os-domain";
import { redactSecrets } from "@opensesame/sdk-cli";
import { describe, expect, it, vi } from "vitest";
import { emit, emitHumanValue, emitMetadata, errorLine } from "./output.js";

function printed(
  flags: Parameters<typeof emit>[0],
  human: string,
  data: Parameters<typeof emit>[2],
) {
  let out = "";
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
  try {
    emit(flags, human, data);
  } finally {
    write.mockRestore();
  }
  return out;
}

const JSON_FLAGS = { json: true } as const;

describe("emit prints the command's own output (ADR 0157)", () => {
  const bearer = "osc_clm_AbCdEfGh1234567890.signature_part";
  const key = "k3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
  const link = dropLink("https://app.example/claim", bearer, key);

  it("keeps a real share link intact under --json, and still redacts by key", () => {
    const out = JSON.parse(
      printed(JSON_FLAGS, `${link}\nCode: ABCD-EFGH`, {
        ok: true,
        link,
        userCode: "ABCD-EFGH",
        password: "hunter2-hunter2",
        access_token: "at-secret-value",
      }),
    );
    expect(out.link).toBe(link);
    expect(out.link).not.toContain("[REDACTED]");
    expect(out.userCode).toBe("ABCD-EFGH");
    expect(out.password).toBe("[redacted]");
    expect(out.access_token).toBe("[redacted]");
  });

  it("keeps an item named like a secret, in a list", () => {
    const out = JSON.parse(
      printed(JSON_FLAGS, "", {
        ok: true,
        items: [{ id: "i1", kind: "secret", name: "GitHub token: work" }],
      }),
    );
    expect(out.items[0].name).toBe("GitHub token: work");
  });

  it("scrubs diagnostic fields that echo a bearer", () => {
    const out = JSON.parse(
      printed(JSON_FLAGS, "", {
        ok: false,
        error: "request failed: Authorization: Bearer abcdefghijklmnop1234",
        nested: { message: "GET https://x.example/cb#token=abcdef123456789" }, // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
      }),
    );
    expect(out.error).not.toContain("abcdefghijklmnop1234");
    expect(out.nested.message).not.toContain("abcdef123456789");
  });

  it("leaves a data field that merely looks like a link alone", () => {
    const redacted = overlapCast(redactSecrets({ link, note: "token: work" }));
    expect(redacted.link).toBe(link);
    expect(redacted.note).toBe("token: work");
  });
});

describe("errorLine", () => {
  it("scrubs a token-shaped value in an error", () => {
    const line = errorLine(
      new Error("refused: https://x.example/cb#token=abcdef123456789&key=zzzz"),
    );
    expect(line).not.toContain("abcdef123456789");
    expect(line.endsWith("\n")).toBe(true);
  });
});

describe("password workflow output boundaries", () => {
  it("redacts metadata while an explicit human read preserves exact bytes", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      emitMetadata({
        ref: "op://vault/item/password",
        access_token: "private-metadata-canary",
      });
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
        ref: "op://vault/item/password",
        access_token: "[redacted]",
      });
      const value = " exact-human-value\n\t";
      emitHumanValue(value);
      expect(write.mock.calls[1]?.[0]).toBe(value);
    } finally {
      write.mockRestore();
    }
  });
});

it("preserves only top-level safe numeric secret echo counts in JSON and human metadata", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const json of [true, false]) {
      emit({ json }, JSON.stringify({ secretEchoes: 2 }), {
        secretEchoes: 2,
        password: "private",
      });
      expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({
        secretEchoes: 2,
        password: "[redacted]",
      });
    }
    for (const secretEchoes of [
      "secret-canary",
      { private: "secret-canary" },
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      emitMetadata({ secretEchoes });
      expect(
        JSON.parse(String(write.mock.calls.at(-1)?.[0])).secretEchoes,
      ).toBe("[redacted]");
    }
  } finally {
    write.mockRestore();
  }
});
