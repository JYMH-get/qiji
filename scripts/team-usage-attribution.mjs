// Read-only report classification. Call only after extracting all listed metadata fields.
export function companyForUsage(log, companyIds, { metadataComplete = false } = {}) {
  if (!metadataComplete) throw new Error('Historical attribution metadata was not extracted');
  if (!log.userId) throw new Error('Non-user ledger entries must be reconciled separately');
  const scope = log.usageReportScope?.companyId;
  const payment = log.pricingAgentId || log.userWallet?.ownerAgentId;
  if (scope && payment && scope !== payment) throw new Error('Report scope and payment company conflict');
  const companyId = scope || payment || log.ownerId || 'source';
  if (!companyIds.has(companyId)) throw new Error('Unknown historical company: ' + companyId);
  if (companyId === 'source' && !scope && !log.creditSource) {
    throw new Error('Source attribution needs a payment trace; absence from current users is insufficient');
  }
  return companyId;
}
