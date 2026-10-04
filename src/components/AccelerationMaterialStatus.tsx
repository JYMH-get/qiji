import { useEffect, useState } from 'react';
import type { AssetRef } from '@/contract';
import { useCatalogStore } from '@/store/catalogStore';
import { useConnectionStore } from '@/store/connectionStore';
import { nyxenMaterialController as controller, nyxenMaterialKey, supportsNyxenMaterials } from '@/services/nyxenMaterialPreparation';
import type { NyxenMaterialKind } from '@/services/nyxenAcceleration';
import type { MaterialPreparationState } from '@/services/materialPreparation';

export function AccelerationMaterialStatus({ modelId, material, kind }: { modelId?: string; material: AssetRef; kind: NyxenMaterialKind }) {
	const model = useCatalogStore(s => s.catalog?.models.find(m => m.id === modelId));
	const session = useConnectionStore(s => `${s.serverUrl}\n${s.accessKey}`);
	const key = supportsNyxenMaterials(model) && (material.id || material.url) ? nyxenMaterialKey(material, kind, session, modelId) : '';
	const [value, setValue] = useState<{ key: string; state: MaterialPreparationState }>();
	useEffect(() => key ? controller.subscribe(key, JSON.stringify([kind, modelId]), material, 'nyxen', state => setValue({ key, state })) : undefined, [key]);
	if (!key) return null;
	const state = value?.key === key ? value.state : controller.peek(key);
	const status = state?.status ?? 'Processing';
	const failed = status === 'Failed';
 const checking = status === 'Processing' && state?.phase !== 'uploading';
	const label = status === 'Active' ? '加速链接已就绪' : failed ? `素材准备失败：${state?.error || '点击重试'}` : checking ? '正在检查加速链接' : '正在上传加速桶';
	return <button type="button" aria-label={failed ? '重试素材加速' : label} title={label}
		data-material-status={status} data-material-phase={checking ? 'checking' : state?.phase} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
		onClick={e => { e.preventDefault(); e.stopPropagation(); if (failed) controller.retry(key); }}
		style={{ position: 'absolute', right: 1, bottom: 1, zIndex: 6, height: 15, minWidth: 15, padding: '0 2px', borderRadius: 4,
			border: '1px solid rgba(255,255,255,.35)', background: status === 'Active' ? '#16864b' : failed ? '#c93442' : checking ? '#626976' : '#6d28d9', color: '#fff', fontSize: 9, lineHeight: '13px', cursor: failed ? 'pointer' : 'default' }}>
		{status === 'Active' ? '✓' : failed ? '!' : '↻'}
	</button>;
}
