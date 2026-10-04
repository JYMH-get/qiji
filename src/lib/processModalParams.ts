export interface ProcessRatioBox { x1: number; y1: number; x2: number; y2: number }

/** Public extras emitted by the image upscale / local erase controls, outside model.params. */
export function processModalParams(params: Record<string, unknown>, extras: { eraseBoxes?: readonly ProcessRatioBox[]; multiple?: number }): Record<string, unknown> {
	const out = { ...params };
	const round3 = (n: number) => Math.round(n * 1000) / 1000;
	if (extras.eraseBoxes) out.erase_ratio_location = extras.eraseBoxes.slice(0, 20).map(box => ({
		top_left_x: round3(box.x1), top_left_y: round3(box.y1),
		bottom_right_x: round3(box.x2), bottom_right_y: round3(box.y2),
	}));
	if (extras.multiple !== undefined) out.multiple = extras.multiple;
	return out;
}
