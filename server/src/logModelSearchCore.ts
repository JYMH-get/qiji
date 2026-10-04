export interface LogModelIdentity { modelId?: string; modelName?: string; familyId?: string; familyName?: string; capability?: string }
export function logPurposeCapability(purpose = ''): string | undefined {
  if (purpose === 'video.upscale') return 'video-enhance';
  if (purpose === 'video.desub') return 'video-erase';
  if (purpose === 'image.upscale') return 'image-enhance';
  if (/^video\./.test(purpose)) return 'video';
  if (/^audio\./.test(purpose)) return 'audio';
  if (/^image\.|^asset\..*\.(image|variant)$/.test(purpose)) return 'image';
  if (/^(script|storyboard|chat)\./.test(purpose) || purpose === 'asset.extract') return 'text';
  return undefined;
}
export function matchesLogModel(identity: LogModelIdentity, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || [identity.modelId, identity.modelName].some(v => v?.toLowerCase().includes(needle));
}
export function matchesLogFamily(identity: LogModelIdentity, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || [identity.familyId, identity.familyName].some(v => v?.toLowerCase().includes(needle));
}
