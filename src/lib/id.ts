let counter = 0;

/** 进程内单调自增 + 时间戳 + 随机后缀，保证一次会话内唯一。 */
export function genId(prefix: string): string {
	counter += 1;
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-${Date.now().toString(36)}-${counter}-${rand}`;
}
