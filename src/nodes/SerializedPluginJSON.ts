export interface PortType {
	name: string;
	formats: string[];
}

export interface SerializedPluginJSON {
	type: string;
	label: string;
	code: string;
	iconName?: string;
	accentVar?: string;
	resultKind?: string;
	defaultModel?: string;
	description?: string;
	category?: string;
	thumbnail?: string | null;
	inputs?: PortType[];
	outputs?: PortType[];
	canStack?: boolean;
	isActive?: boolean;
	isDeleted?: boolean;
	adapter?: {
		key: string;
		displayName?: string;
		vendor?: string;
		baseCost?: number;
		modes?: unknown[];
	};
	scripts?: {
		estimateCost?: string;
		transformInput?: string;
	};
}