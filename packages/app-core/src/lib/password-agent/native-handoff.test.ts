import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nativeRequestCommands } from "./native-handoff.js";
const base = {
  executable: "opensesame-id",
  shell: "posix",
  expiresIn: "10m",
  uses: 1,
  url: "https://example.com/v1/me",
  reference: "op://Automation/Example/credential",
} as const;
describe("native request human handoff", () => {
  it("matches native approval consumption inspection and revocation contracts", () => {
    const result = nativeRequestCommands({ ...base, leaseId: "lease_123" });
    expect(result.approve).toContain("'lease' 'approve'");
    expect(result.approve).toContain(
      "'--desktop' '--expires-in' '10m' '--uses' '1'",
    );
    expect(result.request).toContain("'--lease' 'lease_123'");
    expect(result.status).toContain("'lease' 'status' 'lease_123'");
    expect(result.revoke).toContain("'lease' 'revoke' 'lease_123'");
    expect(nativeRequestCommands(base).request).toBeUndefined();
    expect(
      nativeRequestCommands({ ...base, executable: "opensesame" }).approve,
    ).toContain("'opensesame' 'password-agent'");
  });
  it("POSIX arguments survive quotes and command substitutions as literal bytes", () => {
    const prefix = "quote' $(printf hijacked) `printf hijacked` ";
    const command = nativeRequestCommands({ ...base, prefix }).approve;
    const script = `opensesame-id() { printf "%s\\n" "$@"; }; ${command}`;
    const args = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
    }).split("\n");
    expect(args[args.indexOf("--prefix") + 1]).toBe(prefix);
    expect(args).toContain(base.reference);
  });
  it("uses PowerShell invocation quoting and refuses malformed requests and excessive budgets", () => {
    expect(
      nativeRequestCommands({ ...base, shell: "powershell", prefix: "a'b" })
        .approve,
    ).toContain("& 'opensesame-id'");
    expect(
      nativeRequestCommands({ ...base, shell: "powershell", prefix: "a'b" })
        .approve,
    ).toContain("'a''b'");
    for (const patch of [
      { url: "http://example.com" },
      { reference: "plaintext" },
      { expiresIn: "2h" },
      { uses: 0 },
      { uses: 11 },
      { leaseId: "id; malicious" },
    ])
      expect(() => nativeRequestCommands({ ...base, ...patch })).toThrow();
  });
});
