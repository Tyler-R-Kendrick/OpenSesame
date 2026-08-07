/**
 * Maps Better Auth (or other upstream) user IDs to canonical OpenSesame principal IDs.
 * Better Auth user IDs are never used as downstream `sub` values.
 */
export interface PrincipalMapping {
  principalId: string;
  betterAuthUserId: string;
  /** Upstream provider subject when linked via OIDC (not email). */
  upstreamProviderId?: string;
  upstreamSubject?: string;
  email?: string;
  provisional: boolean;
  createdAt: Date;
  upgradedAt?: Date;
}

export interface PrincipalMappingStore {
  findByBetterAuthUserId(betterAuthUserId: string): Promise<PrincipalMapping | undefined>;
  findByPrincipalId(principalId: string): Promise<PrincipalMapping | undefined>;
  findByUpstream(
    providerId: string,
    subject: string,
  ): Promise<PrincipalMapping | undefined>;
  findByEmail(email: string): Promise<PrincipalMapping | undefined>;
  save(mapping: PrincipalMapping): Promise<PrincipalMapping>;
}

export class MemoryPrincipalMappingStore implements PrincipalMappingStore {
  private readonly byBa = new Map<string, PrincipalMapping>();
  private readonly byPrincipal = new Map<string, PrincipalMapping>();
  private readonly byUpstream = new Map<string, PrincipalMapping>();
  private readonly byEmail = new Map<string, PrincipalMapping>();

  private upstreamKey(providerId: string, subject: string): string {
    return `${providerId}\0${subject}`;
  }

  async findByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<PrincipalMapping | undefined> {
    return this.byBa.get(betterAuthUserId);
  }

  async findByPrincipalId(principalId: string): Promise<PrincipalMapping | undefined> {
    return this.byPrincipal.get(principalId);
  }

  async findByUpstream(
    providerId: string,
    subject: string,
  ): Promise<PrincipalMapping | undefined> {
    return this.byUpstream.get(this.upstreamKey(providerId, subject));
  }

  async findByEmail(email: string): Promise<PrincipalMapping | undefined> {
    return this.byEmail.get(email.toLowerCase());
  }

  async save(mapping: PrincipalMapping): Promise<PrincipalMapping> {
    this.byBa.set(mapping.betterAuthUserId, mapping);
    this.byPrincipal.set(mapping.principalId, mapping);
    if (mapping.upstreamProviderId && mapping.upstreamSubject) {
      this.byUpstream.set(
        this.upstreamKey(mapping.upstreamProviderId, mapping.upstreamSubject),
        mapping,
      );
    }
    if (mapping.email) {
      this.byEmail.set(mapping.email.toLowerCase(), mapping);
    }
    return mapping;
  }
}
