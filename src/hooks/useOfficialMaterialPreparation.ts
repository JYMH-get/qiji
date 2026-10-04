import { useEffect, useState } from "react";
import type { AssetRef } from "@/contract";
import { useCatalogStore } from "@/store/catalogStore";
import { useConnectionStore } from "@/store/connectionStore";
import { type MaterialPreparationState } from "@/services/materialPreparation";
import { supportsOfficialMaterials } from "@/services/materialPolicy";
import { officialMaterialController as controller, officialMaterialKey } from "@/services/officialMaterialClient";

const WAITING: MaterialPreparationState = { status: "Processing", checkedAt: 0 };

/** Route/material changes detach the previous listener, so late responses cannot repaint the new selection. */
export function useOfficialMaterialPreparation(modelId: string | undefined, asset: AssetRef | undefined, active: boolean) {
	const model = useCatalogStore(s => s.catalog?.models.find(m => m.id === modelId));
	const session = useConnectionStore(s => `${s.serverUrl}\n${s.accessKey}`);
	const enabled = active && supportsOfficialMaterials(model) && !!(asset?.id || asset?.url);
	const key = enabled ? officialMaterialKey(session, model, asset) : "";
	const [value, setValue] = useState<{ key: string; state: MaterialPreparationState }>();
	useEffect(() => {
		if (!key || !modelId || !asset) return;
		let mounted = true;
		const detach = controller.subscribe(key, modelId, asset, model?.materialPolicy?.scopeKey, state => {
			if (mounted) setValue({ key, state });
		});
		return () => { mounted = false; detach(); };
	}, [key]);
	return {
		state: key && value?.key === key ? value.state : controller.peek(key) ?? WAITING,
		retry: () => { if (key) controller.retry(key); },
	};
}
