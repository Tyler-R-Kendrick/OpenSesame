import { durationSeconds } from "./lease.js";
import { type RequestOptions, prepareRequest } from "./request.js";

export interface NativeRequestHandoff extends RequestOptions {
  executable: "opensesame" | "opensesame-id";
  shell: "posix" | "powershell";
  expiresIn: string;
  uses: number;
  leaseId?: string;
}
export interface NativeRequestCommands {
  destination: string;
  fingerprint: string;
  approve: string;
  request?: string;
  status?: string;
  revoke?: string;
}
function quote(value: string, shell: NativeRequestHandoff["shell"]): string {
  return shell === "powershell"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
/** A reviewable human handoff, never an approval or an execution primitive. */
export function nativeRequestCommands(options: NativeRequestHandoff) {
  const prepared = prepareRequest(options);
  durationSeconds(options.expiresIn);
  if (!Number.isInteger(options.uses) || options.uses < 1 || options.uses > 10)
    throw new Error(
      "Choose a lifetime up to one hour and between one and ten uses.",
    );
  if (
    options.leaseId !== undefined &&
    !/^[a-zA-Z0-9_-]{1,128}$/.test(options.leaseId)
  )
    throw new Error("Enter the lease ID returned by the native CLI.");
  const root =
    options.executable === "opensesame"
      ? ["opensesame", "password-agent"]
      : ["opensesame-id"];
  const request = [
    prepared.url.href,
    "--secret",
    options.reference,
    "--header",
    prepared.header,
    "--prefix",
    prepared.prefix,
  ];
  const command = (args: string[]) =>
    `${options.shell === "powershell" ? "& " : ""}${args.map((arg) => quote(arg, options.shell)).join(" ")}`;
  const result: NativeRequestCommands = {
    destination: prepared.binding.destination,
    fingerprint: prepared.binding.destinationFingerprint,
    approve: command([
      ...root,
      "lease",
      "approve",
      ...request,
      "--desktop",
      "--expires-in",
      options.expiresIn,
      "--uses",
      String(options.uses),
    ]),
  };
  if (options.leaseId) {
    result.request = command([
      ...root,
      "request",
      ...request,
      "--lease",
      options.leaseId,
    ]);
    result.status = command([...root, "lease", "status", options.leaseId]);
    result.revoke = command([...root, "lease", "revoke", options.leaseId]);
  }
  return result;
}
