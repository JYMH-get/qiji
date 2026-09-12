import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartInferSpec } from './inferRun';
import { startInfer } from './inferRun';

const mocks = vi.hoisted(() => ({ runPurpose: vi.fn(), state: {} as any }));
vi.mock('./purposeRunner', () => ({ runPurpose: mocks.runPurpose }));
vi.mock('./taskCenter', () => ({ trackTask: vi.fn() }));
vi.mock('./generationQueue', () => ({ setJobProgress: vi.fn(), clearJobProgress: vi.fn() }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => mocks.state } }));

beforeEach(() => {
  mocks.runPurpose.mockReset().mockImplementation(() => new Promise(() => {}));
  const state = mocks.state;
  state.inferTasks = [];
  state.episodes = [{ id: 'episode', shots: [{ id: 'shot', index: 1, title: '分镜1', scriptSegment: '原始分镜', prompt: '', materials: [] }] }];
  state.save = vi.fn(async () => {});
  state.addInferTask = (task: any) => state.inferTasks.push(task);
  state.removeInferTask = (id: string) => { state.inferTasks = state.inferTasks.filter((task: any) => task.id !== id); };
  state.updateInferTask = (id: string, patch: any) => Object.assign(state.inferTasks.find((task: any) => task.id === id), patch);
  state.updateShot = (_episodeId: string, id: string, patch: any) => Object.assign(state.episodes[0].shots.find((shot: any) => shot.id === id), patch);
  state.setEpisodeShots = (_episodeId: string, shots: any[]) => { state.episodes[0].shots = shots; };
});

describe('表格推理请求与结果', () => {
  it.each([
    ['multi', false, 'storyboard.toVideoPrompt'],
    ['multi', true, 'storyboard.unified'],
    ['single', false, 'storyboard.singleShot'],
    ['single', true, 'storyboard.unifiedShot'],
  ] as const)('触发位置 %s / 同源 %s 决定格式，与方案旧用途无关', (mode, sameSource, purpose) => {
    const variables = { 原文: '人物推门。', 上一分镜: '人物来到门口。', 下一分镜: '人物落座。' };
    const inference = { source: 'template' as const, guidance: '保持前后动作连贯', durationLimit: 30 as const };
    for (const templateId of ['smart.infer.multi', 'smart.infer.unified', 'smart.infer.single']) {
      startInfer({ episodeId: 'episode', shotId: 'shot', mode, sameSource, templateId, inference, variables });
      expect(mocks.runPurpose).toHaveBeenLastCalledWith(purpose, expect.objectContaining({ templateId, input: { inference }, variables }));
    }
    const skillInference = { ...inference, source: 'skill' as const, skillText: '自由创作 {{用户自有变量}}' };
    startInfer({ episodeId: 'episode', shotId: 'shot', mode, sameSource, templateId: '', inference: skillInference, variables });
    expect(mocks.runPurpose).toHaveBeenLastCalledWith(purpose, expect.objectContaining({ templateId: '', input: { inference: skillInference }, variables }));
  });

  it.each([false, true])('单镜仅写入所选输出字段，同源=%s，保留原文', async sameSource => {
    const response = JSON.stringify([{ card_number: 1, duration: 30, original_script: '不得覆盖本镜原文', storyboard_prompts: '故事板', video_prompts: '视频', unified_prompt: '共用提示词' }]);
    mocks.runPurpose.mockResolvedValue({ status: 'success', resultUri: response });
    startInfer({ episodeId: 'episode', shotId: 'shot', mode: 'single', sameSource, templateId: sameSource ? 'smart.infer.multi' : 'smart.infer.unified', inference: { source: 'template', durationLimit: 30 }, variables: { 原文: '原始分镜' } });
    await Promise.resolve();
    const shot = mocks.state.episodes[0].shots[0];
    expect(shot.scriptSegment).toBe('原始分镜');
    expect(shot.durationSec).toBe(30);
    expect(shot.unifiedPrompt).toBe(sameSource ? '共用提示词' : undefined);
    expect(shot.storyboardPrompt).toBe(sameSource ? undefined : '故事板');
    expect(shot.videoPrompt).toBe(sameSource ? undefined : '视频');
    expect(mocks.state.inferTasks).toEqual([]);
  });

  it.each([false, true])('仅拆分保留拆分用途，输出模式按用户选择 %s', sameSource => {
    const spec: StartInferSpec = { episodeId: 'episode', mode: 'split', sameSource, templateId: 'jianyi', inference: { source: 'template', durationRange: { min: 4, max: 30 }, guidance: '保持剧情完整' }, variables: { 原文: '本集原文' } };
    startInfer(spec);
    expect(mocks.runPurpose).toHaveBeenCalledWith('storyboard.split', expect.objectContaining({ templateId: 'jianyi', input: { inference: { ...spec.inference, outputMode: sameSource ? 'unified' : 'storyboard' } }, variables: spec.variables }));
  });

  it.each([false, true])('仅拆分只写原文和时长，忽略模型多余提示词，同源=%s', async sameSource => {
    mocks.state.episodes[0].shots = [];
    const response = JSON.stringify([{ card_number: 1, duration: 30, original_script: '拆出的原文', storyboard_prompts: '不应写入故事板', video_prompts: '不应写入视频', unified_prompt: '不应写入同源' }]);
    mocks.runPurpose.mockResolvedValue({ status: 'success', resultUri: response });
    startInfer({ episodeId: 'episode', mode: 'split', sameSource, templateId: 'jianyi', inference: { source: 'template', durationRange: { min: 4, max: 30 } }, variables: { 原文: '拆出的原文' } });
    await Promise.resolve();
    const shot = mocks.state.episodes[0].shots[0];
    expect(shot.scriptSegment).toBe('拆出的原文');
    expect(shot.durationSec).toBe(30);
    expect(shot.storyboardPrompt).toBeUndefined();
    expect(shot.videoPrompt).toBeUndefined();
    expect(shot.unifiedPrompt).toBeUndefined();
    expect(mocks.state.inferTasks).toEqual([]);
  });
});
