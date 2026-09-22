/** Limits applied by `parseClientCertFields`; mirrors `IngressLimits` in Rust. */
export interface IngressLimits {
  /** Largest decoded certificate accepted, leaf or chain member. */
  readonly maxCertificateBytes: number;
  /** Most chain members accepted after a leading duplicate of the leaf is dropped. */
  readonly maxChainCertificates: number;
  /** Most undecoded bytes across every Client-Cert and Client-Cert-Chain field value. */
  readonly maxTotalHeaderBytes: number;
}

/** 16 KiB per certificate, 8 chain certificates, 64 KiB of header text. */
export const DEFAULT_INGRESS_LIMITS: IngressLimits = Object.freeze({
  maxCertificateBytes: 16 * 1024,
  maxChainCertificates: 8,
  maxTotalHeaderBytes: 64 * 1024,
});
