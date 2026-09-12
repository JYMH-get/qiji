/** 以手势开始的尺寸为基准，避免多次 mousemove 累乘字号。 */
export function resizedMarkerFontSize(fontSize: number, initialWidth: number, width: number): number {
	return Math.max(1, fontSize * width / Math.max(1, initialWidth));
}

/** 实心箭头：细尾、渐宽箭杆、三角箭头；方向由起笔到落笔决定。 */
export function markerArrowPoints(width: number, height: number, flipX = false, flipY = true): string {
	const sx = flipX ? width : 0, sy = flipY ? height : 0;
	const ex = flipX ? 0 : width, ey = flipY ? 0 : height;
	const length = Math.max(1, Math.hypot(ex - sx, ey - sy));
	const ux = (ex - sx) / length, uy = (ey - sy) / length;
	const head = Math.min(26, length * 0.28), halfHead = head * 0.46;
	const bx = ex - ux * head, by = ey - uy * head;
	const point = (x: number, y: number, side: number) => `${x - uy * side},${y + ux * side}`;
	return [point(sx, sy, 0), point(bx, by, head * 0.12), point(bx - ux * 2, by - uy * 2, halfHead),
		point(ex, ey, 0), point(bx - ux * 2, by - uy * 2, -halfHead), point(bx, by, -head * 0.12)].join(" ");
}
