export type IdentitySession = {
  principalId: string;
  accessToken: string;
  expiresAt: string;
};

export class IdentityError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function identityBase(): string {
  return "";
}
export function hostBase(): string {
  return "";
}
export function identityJson<T>(_path: string, _init?: RequestInit): Promise<T> {
  return Promise.reject(new Error("stub"));
}
export function useIdentitySession(): IdentitySession | null {
  return null;
}
export function useConnect(): {
  connecting: boolean;
  error: string | null;
  connect: () => Promise<IdentitySession>;
} {
  return {
    connecting: false,
    error: null,
    connect: () => Promise.reject(new Error("stub")),
  };
}
