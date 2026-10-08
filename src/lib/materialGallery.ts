/** Session-local identity distinguishes duplicate URIs without changing saved material data. */
export function createGalleryIdentity<T extends object>() {
	const ids = new WeakMap<T, string>();
	let serial = 0;
	return (item: T): string => {
		let id = ids.get(item);
		if (!id) { id = `gallery-${++serial}`; ids.set(item, id); }
		return id;
	};
}

export function moveGalleryItem<T>(items: readonly T[], fromId: string, toId: string, idOf: (item: T) => string): T[] | null {
	const from = items.findIndex(item => idOf(item) === fromId);
	const to = items.findIndex(item => idOf(item) === toId);
	if (from < 0 || to < 0 || from === to) return null;
	const next = [...items];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}
