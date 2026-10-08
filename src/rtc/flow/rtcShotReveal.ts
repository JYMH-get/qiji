/** 只滚动时间轴自己的视口；片段起点留白，竖向仅移动到可见区域。 */
export function scrollToRtcShot(
	viewport: HTMLElement,
	segmentId: string,
	positionUs: number,
	pxPerSec: number,
	topInset: number,
): boolean {
	const segment = Array.from(viewport.querySelectorAll<HTMLElement>("[data-seg]")).find(el => el.dataset.seg === segmentId);
	if (!segment) return false;
	const view = viewport.getBoundingClientRect(), rect = segment.getBoundingClientRect();
	const topEdge = view.top + topInset + 4, bottomEdge = view.bottom - 8;
	let top = viewport.scrollTop;
	if (rect.top < topEdge) top -= topEdge - rect.top;
	else if (rect.bottom > bottomEdge) top += rect.bottom - bottomEdge;
	viewport.scrollTo({ left: Math.max(0, positionUs / 1_000_000 * pxPerSec - 24), top: Math.max(0, top), behavior: "smooth" });
	return true;
}
