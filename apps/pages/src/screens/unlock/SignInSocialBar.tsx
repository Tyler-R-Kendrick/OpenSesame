/**
 * The social sign-in bar: brand marks, overflow, last-used mark.
 *
 * Last-used is the method that actually completed, promoted to the front of
 * the row and ringed so a Google user does not tap GitHub by proximity.
 */

import type { ReactNode, RefObject } from "react";
import { IconDots, IconLogin, IconSite } from "../../components/Icons.js";
import type { TrustedUpstream } from "../../lib/federation.js";
import {
  isLastSignInMethod,
  promoteLastSignIn,
} from "../../lib/last-sign-in.js";
import type { FederatedProviderSummary } from "../../lib/providers.js";
import type { OperatorIdp, SignInMethods } from "../../lib/settings.js";
import { brandFor } from "./ProviderBrand.js";

const VISIBLE_PROVIDERS = 4;

type Props = {
  busy: boolean;
  lastMethod: string | null;
  methods: SignInMethods;
  catalogProviders: FederatedProviderSummary[];
  fallbackUpstream: TrustedUpstream | null;
  hasIdentityService: boolean;
  menuOpen: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOperator: (idp: OperatorIdp) => void;
  onProvider: (provider: FederatedProviderSummary) => void;
  onFallback: () => void;
  onByo: () => void;
  onMagicLink: () => void;
};

function named(label: string, last: boolean): string {
  return last ? `${label} · last used` : label;
}

function SocialButton({
  last,
  label,
  brandClass,
  disabled,
  onClick,
  children,
}: {
  last: boolean;
  label: string;
  brandClass?: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn signin__social${brandClass ? ` ${brandClass}` : ""}${last ? " is-last" : ""}`}
      aria-label={named(label, last)}
      title={named(label, last)}
      aria-current={last ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SignInSocialBar({
  busy,
  lastMethod,
  methods,
  catalogProviders,
  fallbackUpstream,
  hasIdentityService,
  menuOpen,
  menuRef,
  onToggleMenu,
  onCloseMenu,
  onOperator,
  onProvider,
  onFallback,
  onByo,
  onMagicLink,
}: Props) {
  const operators = promoteLastSignIn(
    methods.providers,
    lastMethod,
    (idp) => idp.providerId,
  );
  const orderedCatalog = promoteLastSignIn(
    catalogProviders,
    lastMethod,
    (provider) => provider.id,
  );
  const visible = orderedCatalog.slice(0, VISIBLE_PROVIDERS);
  const overflow = orderedCatalog.slice(VISIBLE_PROVIDERS);
  const caption = lastUsedCaption(
    lastMethod,
    operators,
    orderedCatalog,
    fallbackUpstream,
    hasIdentityService,
  );

  return (
    <>
      <div className="signin__bar">
        {operators.map((idp) => {
          const brand = brandFor(idp.providerId);
          return (
            <SocialButton
              key={idp.issuer}
              last={isLastSignInMethod(idp.providerId, lastMethod)}
              label={`Continue with ${idp.label}`}
              brandClass={brand?.className}
              disabled={busy}
              onClick={() => onOperator(idp)}
            >
              {brand ? <brand.Icon size={20} /> : <IconSite size={20} />}
            </SocialButton>
          );
        })}
        <CatalogMarks
          busy={busy}
          lastMethod={lastMethod}
          catalogProviders={catalogProviders}
          visible={visible}
          fallbackUpstream={fallbackUpstream}
          onProvider={onProvider}
          onFallback={onFallback}
        />
        {hasIdentityService ? (
          <SocialButton
            last={isLastSignInMethod("byo", lastMethod)}
            label="Continue with your IdP"
            disabled={busy}
            onClick={onByo}
          >
            <IconSite size={20} />
          </SocialButton>
        ) : null}
        <OverflowMenu
          busy={busy}
          lastMethod={lastMethod}
          overflow={overflow}
          hasIdentityService={hasIdentityService}
          menuOpen={menuOpen}
          menuRef={menuRef}
          onToggleMenu={onToggleMenu}
          onCloseMenu={onCloseMenu}
          onProvider={onProvider}
          onMagicLink={onMagicLink}
        />
      </div>
      {caption ? <p className="signin__last-note">{caption}</p> : null}
    </>
  );
}

function CatalogMarks({
  busy,
  lastMethod,
  catalogProviders,
  visible,
  fallbackUpstream,
  onProvider,
  onFallback,
}: {
  busy: boolean;
  lastMethod: string | null;
  catalogProviders: FederatedProviderSummary[];
  visible: FederatedProviderSummary[];
  fallbackUpstream: TrustedUpstream | null;
  onProvider: (provider: FederatedProviderSummary) => void;
  onFallback: () => void;
}) {
  if (catalogProviders.length > 0) {
    return visible.map((provider) => {
      const brand = brandFor(provider.id);
      return (
        <SocialButton
          key={provider.id}
          last={isLastSignInMethod(provider.id, lastMethod)}
          label={`Continue with ${brand?.label ?? provider.label}`}
          brandClass={brand?.className}
          disabled={busy}
          onClick={() => onProvider(provider)}
        >
          {brand ? <brand.Icon size={20} /> : <IconLogin size={20} />}
        </SocialButton>
      );
    });
  }
  if (!fallbackUpstream) return null;
  const brand = brandFor(fallbackUpstream.id);
  return (
    <SocialButton
      last={isLastSignInMethod(fallbackUpstream.id, lastMethod)}
      label={`Continue with ${brand?.label ?? fallbackUpstream.accountKind}`}
      brandClass={brand?.className}
      disabled={busy}
      onClick={onFallback}
    >
      {brand ? <brand.Icon size={20} /> : <IconLogin size={20} />}
    </SocialButton>
  );
}

function OverflowMenu({
  busy,
  lastMethod,
  overflow,
  hasIdentityService,
  menuOpen,
  menuRef,
  onToggleMenu,
  onCloseMenu,
  onProvider,
  onMagicLink,
}: {
  busy: boolean;
  lastMethod: string | null;
  overflow: FederatedProviderSummary[];
  hasIdentityService: boolean;
  menuOpen: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onProvider: (provider: FederatedProviderSummary) => void;
  onMagicLink: () => void;
}) {
  if (overflow.length === 0 && !hasIdentityService) return null;
  return (
    <div className="signin__menuwrap" ref={menuRef}>
      <button
        type="button"
        className="btn signin__social"
        aria-label="More sign-in options"
        title="More sign-in options"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={onToggleMenu}
      >
        <IconDots size={20} />
      </button>
      {menuOpen ? (
        <div className="signin__menu">
          {overflow.map((provider) => {
            const brand = brandFor(provider.id);
            const last = isLastSignInMethod(provider.id, lastMethod);
            const label = `Continue with ${brand?.label ?? provider.label}`;
            return (
              <button
                key={provider.id}
                type="button"
                className={`signin__menu-item${last ? " is-last" : ""}`}
                disabled={busy}
                onClick={() => {
                  onCloseMenu();
                  onProvider(provider);
                }}
              >
                {brand ? <brand.Icon size={18} /> : <IconLogin size={18} />}
                {named(label, last)}
              </button>
            );
          })}
          <button
            type="button"
            className="signin__menu-item"
            disabled={busy}
            onClick={() => {
              onCloseMenu();
              onMagicLink();
            }}
          >
            <IconLogin size={18} />
            Email me a sign-in link
          </button>
        </div>
      ) : null}
    </div>
  );
}

function lastUsedCaption(
  last: string | null,
  operators: SignInMethods["providers"],
  catalog: FederatedProviderSummary[],
  fallback: TrustedUpstream | null,
  hasByo: boolean,
): string | null {
  if (!last) return null;
  const operator = operators.find((idp) =>
    isLastSignInMethod(idp.providerId, last),
  );
  if (operator) return `Last used · ${operator.label}`;
  const provider = catalog.find((entry) => isLastSignInMethod(entry.id, last));
  if (provider) {
    return `Last used · ${brandFor(provider.id)?.label ?? provider.label}`;
  }
  if (fallback && isLastSignInMethod(fallback.id, last)) {
    return `Last used · ${brandFor(fallback.id)?.label ?? fallback.accountKind}`;
  }
  if (last === "byo" && hasByo) return "Last used · your IdP";
  return null;
}
