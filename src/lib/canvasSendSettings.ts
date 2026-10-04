import type { CanvasSendSettings } from '@/services/projectFile';

export const CANVAS_SEND_OPTIONS = [
  ['assets', '资产'], ['connections', '连线'], ['group', '是否分组'],
  ['inference', '推理节点'], ['original', '原文节点'],
  ['storyboard', '故事板节点'], ['video', '视频节点'],
] as const;

export function resolveCanvasSendSettings(saved?: Partial<CanvasSendSettings>): CanvasSendSettings {
  const settings = { assets: false, connections: true, group: false, inference: true,
    original: true, storyboard: true, video: true, ...saved };
  // 没有原文时，不保留上游整集推理；恢复原文后沿用用户的推理偏好。
  return { ...settings, inference: settings.original && settings.inference };
}
