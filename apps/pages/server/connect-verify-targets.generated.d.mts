export type VerifyTarget = {
  kind: "oauth" | "api-key" | "mcp";
  method: "GET" | "POST";
  url: string;
  accountField: string | null;
  header: string | null;
  scheme: string | null;
  basic: { username: string; password: string } | null;
  headers: Record<string, string>;
  body: string | null;
  sources: { template: string; field: string }[];
  success?: { field: string; equals: string | number | boolean | null }[];
  requiredFields?: string[];
  errorFields?: string[];
};

export const VERIFY_TARGETS: Readonly<
  Record<
    string,
    { oauth?: VerifyTarget; apiKey?: VerifyTarget; mcp?: VerifyTarget }
  >
>;
export const VERIFY_HOSTS: Readonly<Record<string, string>>;
