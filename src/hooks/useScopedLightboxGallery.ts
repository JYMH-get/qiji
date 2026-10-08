import { useLayoutEffect, useMemo, useRef } from "react";
import { openLightboxGallery, type LightboxGallerySource } from "@/store/lightboxStore";

/** A gallery belongs to the mounted list and its current scope, never a captured array. */
export function useScopedLightboxGallery(scopeKey: string, options: LightboxGallerySource) {
	const latest = useRef({ scopeKey, options });
	latest.current = { scopeKey, options };
	const session = useMemo(() => {
		let mounted = true;
		const listeners = new Set<() => void>();
		const current = () => mounted && latest.current.scopeKey === scopeKey;
		const notify = () => listeners.forEach(listener => listener());
		const source: LightboxGallerySource = {
			getItems: () => current() ? latest.current.options.getItems() : null,
			canReorder: () => current() && !!latest.current.options.reorder && (latest.current.options.canReorder?.() ?? true),
			reorder: (from, to) => {
				if (current() && latest.current.options.getItems() && (latest.current.options.canReorder?.() ?? true)) {
					latest.current.options.reorder?.(from, to);
				}
			},
			subscribe: listener => {
				listeners.add(listener);
				const unsubscribe = latest.current.options.subscribe?.(listener);
				return () => { listeners.delete(listener); unsubscribe?.(); };
			},
		};
		return { source, notify, activate: () => { mounted = true; }, dispose: () => { mounted = false; notify(); } };
	}, [scopeKey]);
	useLayoutEffect(() => { session.activate(); return session.dispose; }, [session]);
	useLayoutEffect(() => { session.notify(); });
	return (activeId: string) => openLightboxGallery(session.source, activeId);
}
