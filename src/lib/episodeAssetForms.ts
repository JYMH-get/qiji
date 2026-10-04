import { useProjectStore } from '@/store/projectStore';
import { matchAssetsInText } from './assetMatch';
import type { VideoEpisode } from '@/services/projectFile';

/** 同步范围为本集实际引用及原文匹配的造型，不把其它集或未使用造型带入。 */
export function episodeAssetForms(episode?: VideoEpisode): Set<string> {
  const used = new Set<string>();
  if (!episode) return used;
  const ps = useProjectStore.getState();
  const assets = [...ps.characters, ...ps.scenes, ...ps.crowds, ...ps.organisms, ...ps.items];
  const sameImage = (a?: string, b?: string) => !!a && !!b && (a === b ||
    (!!ps.blobByUri(a)?.id && ps.blobByUri(a)?.id === ps.blobByUri(b)?.id));
  const add = (id?: string, uri?: string) => {
    for (const asset of assets) {
      const variant = (asset.variants ?? []).find(v => v.id === id || sameImage(v.image, uri) || (v.images ?? []).some(img => sameImage(img, uri)));
      if (variant) { used.add(asset.id + ':' + variant.id); return; }
      if (asset.id === id || sameImage(asset.image, uri) || (asset.images ?? []).some(img => sameImage(img, uri))) {
        used.add(asset.id); return;
      }
    }
  };
  for (const shot of episode.shots) for (const material of shot.materials ?? []) {
    add(material.assetId, material.uri);
    if (material.voiceForAssetId) add(material.voiceForAssetId);
  }
  // 每段独立匹配，复用对白排除/最长名优先/造型选择规则。
  for (const text of [episode.scriptText, ...episode.shots.map(s => s.scriptSegment || s.prompt || '')]) {
    for (const match of matchAssetsInText(text || '')) add(match.assetId, match.image);
  }
  return used;
}
