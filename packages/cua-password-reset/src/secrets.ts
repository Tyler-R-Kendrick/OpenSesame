import {
  type PasswordMethod,
  completePassword,
  producePassword,
} from "@opensesame/vault-core";
import { type ProxyProof, proxyProofSchema } from "./types.js";

export type CandidateSource =
  | PasswordMethod
  | (() => PasswordMethod | Promise<PasswordMethod>);
export type PasswordProductionAuthority = () => void | Promise<void>;

export class CandidateCustody {
  constructor(
    private readonly source: CandidateSource,
    private readonly authorize: PasswordProductionAuthority = () => {},
  ) {}

  async withPassword<T>(use: (password: string) => Promise<T>): Promise<T> {
    await this.authorize();
    const method = typeof this.source === "function" ? await this.source() : this.source;
    const password = completePassword(producePassword(method));
    if (password === null || password === "")
      throw new Error("The vault facade did not produce a complete reset candidate");
    return use(password);
  }

  async withSynthetic<T>(
    proxy: ProxyProof,
    use: (synthetic: string) => Promise<T>,
  ): Promise<T> {
    assertProxyLane(true, proxy);
    return this.withPassword((password) => use(sameShape(password)));
  }
}

export function assertProxyLane(synthetic: boolean, proxy: ProxyProof | undefined): void {
  if (!synthetic) return;
  if (!proxy) throw new Error("A synthetic password requires the exact-form network proxy");
  proxyProofSchema.parse(proxy);
}

function sameShape(password: string): string {
  return [...password].map((character) => {
    if (/[a-z]/u.test(character)) return randomFrom("abcdefghijklmnopqrstuvwxyz");
    if (/[A-Z]/u.test(character)) return randomFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    if (/[0-9]/u.test(character)) return randomFrom("0123456789");
    return character;
  }).join("");
}

function randomFrom(characters: string): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return characters[(values[0] ?? 0) % characters.length] ?? "";
}
