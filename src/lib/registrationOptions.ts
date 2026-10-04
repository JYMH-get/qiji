export interface RegistrationOptions { enabled: boolean; email: boolean; phone: boolean }
export function registrationChannels(options: RegistrationOptions | null) {
  const label = options?.email && options.phone ? '邮箱 / 手机号' : options?.phone ? '手机号' : options?.email ? '邮箱' : '账号';
  const placeholder = options?.email && options.phone ? 'you@example.com 或 13800000000' : options?.phone ? '13800000000' : options?.email ? 'you@example.com' : '请先加载验证方式';
  return { label, placeholder, available: !!options && (options.email || options.phone) };
}
export function verificationTargetError(target: string, options: RegistrationOptions | null): string | null {
  if (!options) return '验证方式尚未加载，请稍后重试';
  if (!target.trim()) return `请填写${registrationChannels(options).label}`;
  if (target.includes('@')) return options.email ? null : '邮箱验证暂未开放';
  return options.phone ? null : options.email ? '当前仅支持邮箱验证，请填写邮箱' : '验证通道暂未开放，请联系管理员';
}
