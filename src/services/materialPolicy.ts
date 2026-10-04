import type { CatalogModel } from "@/contract";

/** New catalogs declare the request protocol. The boolean only supports older servers. */
export function supportsOfficialMaterials(model?: CatalogModel | null): boolean {
	return model?.materialPolicy ? model.materialPolicy.kind === "official-assets" : model?.officialAssets === true;
}
