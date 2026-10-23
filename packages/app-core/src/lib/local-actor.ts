/**
 * Who is acting in this vault right now, for records that need a person.
 *
 * A local session is the strongest answer: it is a validated tab-owned
 * presentation. A remote Identity session is the next. Neither is proof of a
 * role; callers still check their own authority.
 */
export async function currentActorPrincipalId(
  tomb: string,
): Promise<string | null> {
  try {
    const { currentLocalIdentitySession, listLocalIdentitySessions } =
      await import("./local-sessions.js");
    for (const session of await listLocalIdentitySessions(tomb)) {
      if (await currentLocalIdentitySession(tomb, session.principalId))
        return session.principalId;
    }
  } catch {
    // A locked or absent local IAM session leaves the remote session below.
  }
  try {
    const { currentSession } = await import("./identity.js");
    return currentSession()?.principalId ?? null;
  } catch {
    return null;
  }
}
