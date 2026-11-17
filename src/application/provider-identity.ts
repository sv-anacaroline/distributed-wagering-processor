/**
 * A provider ID from an OIDC token or a trusted SQS envelope is business
 * identity data. Both entrypoints must use exactly the same allowlist.
 * Local bypass is explicit; production always fails closed.
 */
export function isFinancialProviderIdAllowed(providerId?: string): boolean {
  if (process.env.HTTP_AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production') {
    return true;
  }
  const configured = process.env.OIDC_PROVIDER_CLIENT_IDS;
  const permitted = (configured ?? (process.env.NODE_ENV === 'production' ? '' : 'provider-a,provider-b'))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return (
    Boolean(providerId) &&
    providerId !== (process.env.OIDC_METRICS_CLIENT_ID ?? 'wagering-monitor') &&
    permitted.includes(providerId ?? '')
  );
}
