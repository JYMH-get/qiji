import { describe, expect, it } from 'vitest';
import { logPurposeCapability, matchesLogModel, matchesLogFamily } from '../../server/src/logModelSearchCore';
describe('请求记录分开搜索模型与家族', () => {
  it('已删除模型可用请求用途归类，文本推理不混进图片视频', () => {
    expect(logPurposeCapability('storyboard.unifiedShot')).toBe('text');
    expect(logPurposeCapability('asset.scene.image')).toBe('image');
    expect(logPurposeCapability('video.generate')).toBe('video');
    expect(logPurposeCapability('audio.tts')).toBe('audio');
    expect(logPurposeCapability('code.issue')).toBeUndefined();
  });
  const identity = { modelId: 'seedance 2.0', modelName: '高速二', familyId: 'fam-video', familyName: 'Seedance 2.0 Fast' };
  it('模型 ID 支持中段与大小写忽略', () => {
    expect(matchesLogModel(identity, 'eedan')).toBe(true);
    expect(matchesLogModel(identity, ' EEDAN ')).toBe(true);
  });
  it('模型名称支持中段', () => expect(matchesLogModel(identity, '速二')).toBe(true));
  it('模型搜索不混入家族名或 ID', () => {
    expect(matchesLogModel(identity, 'Fast')).toBe(false);
    expect(matchesLogModel(identity, 'fam-video')).toBe(false);
  });
  it('家族可以独立搜索名称和 ID', () => {
    expect(matchesLogFamily(identity, 'fast')).toBe(true);
    expect(matchesLogFamily(identity, 'fam-video')).toBe(true);
    expect(matchesLogFamily(identity, '高速二')).toBe(false);
  });
  it('未分配模型的线路不能靠家族命中模型查询', () => {
    expect(matchesLogModel({ familyName: 'Seedance 2.0' }, 'eedan')).toBe(false);
  });
});
