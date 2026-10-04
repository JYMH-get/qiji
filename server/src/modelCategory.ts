import type { Capability } from './contract.ts';

/** Display categories do not replace the precise capability used for dispatch. */
export const MODEL_CATEGORIES = ['image', 'video', 'text', 'audio', 'other'] as const;
export type ModelCategory = typeof MODEL_CATEGORIES[number];
export const MODEL_CAPABILITIES: readonly Capability[] = ['image', 'video', 'text', 'audio', 'video-enhance', 'video-erase', 'image-enhance'];
export const isModelCapability = (value: unknown): value is Capability => MODEL_CAPABILITIES.includes(value as Capability);
export const modelCategory = (capability: string): ModelCategory =>
  capability === 'image' || capability === 'video' || capability === 'text' || capability === 'audio' ? capability : 'other';

export const PROCESSING_CAPABILITY_NAMES: Partial<Record<Capability, string>> = {
  'video-enhance': '视频超分',
  'video-erase': '视频去字幕',
  'image-enhance': '图像超分',
};
