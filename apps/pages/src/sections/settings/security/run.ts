/**
 * How every ceremony in the Security sheet performs an action: the panel
 * owns the busy flag and the status note, the ceremony hands it the work
 * and the sentence to show when it lands.
 */
export type Run = (action: () => Promise<void>, ok: string) => Promise<void>;
