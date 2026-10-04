/** AISC GPT Image 2 的档位表，以渠道公布的像素组合为准，不能按长边猜测档位。 */
export const AISC_IMAGE_SIZES: Record<string, Record<string, string>> = {
  '21:9': { '1k': '1344x576', '2k': '2688x1152', '4k': '3840x1648' },
  '16:9': { '1k': '1280x720', '2k': '2048x1152', '4k': '3840x2160' },
  '4:3': { '1k': '1024x768', '2k': '2048x1536', '4k': '3312x2480' },
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:4': { '1k': '768x1024', '2k': '1536x2048', '4k': '2480x3312' },
  '9:16': { '1k': '720x1280', '2k': '1152x2048', '4k': '2160x3840' },
};

export type ImageSizeMap = Record<string, Record<string, string>>;
export function validateImageSizeMap(value: unknown): ImageSizeMap | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('图片请求对应表格式错误');
  const result: ImageSizeMap = {};
  for (const [aspect, row] of Object.entries(value)) {
    if (!/^[1-9]\d*(?:\.\d+)?:[1-9]\d*(?:\.\d+)?$/.test(aspect) || !row || typeof row !== 'object' || Array.isArray(row)) throw new Error('图片请求对应表比例无效');
    result[aspect] = {};
    for (const [resolution, input] of Object.entries(row)) {
      if (!/^[1-9]\d*(?:\.\d+)?k?$/.test(resolution) || typeof input !== 'string') throw new Error('图片请求对应表档位无效');
      const size = input.trim().replace(/[×X]/g, 'x').replace(/\s/g, '');
      if (!size) continue;
      if (!/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size)) throw new Error('尺寸请输入宽×高，例如 2048×1152');
      result[aspect][resolution] = size;
    }
  }
  return result;
}
