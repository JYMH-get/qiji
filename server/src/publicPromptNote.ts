/** Notes are display-only text, separate from the executable prompt body. */
export function publicPromptNote(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 10000) {
    throw Object.assign(new Error('可见注释须为不超过 10000 字的文本'), { statusCode: 400 });
  }
  return value.trim() || undefined;
}
