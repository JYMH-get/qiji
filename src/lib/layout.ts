import { useCanvasStore } from "@/store/canvasStore";

export function autoLayoutCanvas() {
	const store = useCanvasStore.getState();
	const nodes = Object.values(store.nodes);
	const edges = Object.values(store.edges);

	if (nodes.length === 0) return;

	// Calculate in-degree and adjacency list
	const nodeIds = nodes.map((n) => n.id);
	const inDegree: Record<string, number> = {};
	const adj: Record<string, string[]> = {};

	for (const id of nodeIds) {
		inDegree[id] = 0;
		adj[id] = [];
	}

	for (const edge of edges) {
		if (adj[edge.source] && inDegree[edge.target] !== undefined) {
			adj[edge.source].push(edge.target);
			inDegree[edge.target]++;
		}
	}

	// Queue for Kahn's algorithm / layer assignment
	const layers: Record<string, number> = {};
	const queue: string[] = [];

	for (const id of nodeIds) {
		if (inDegree[id] === 0) {
			layers[id] = 0;
			queue.push(id);
		}
	}

	while (queue.length > 0) {
		const curr = queue.shift()!;
		const currLayer = layers[curr];
		for (const neighbor of adj[curr]) {
			layers[neighbor] = Math.max(layers[neighbor] ?? 0, currLayer + 1);
			inDegree[neighbor]--;
			if (inDegree[neighbor] === 0) {
				queue.push(neighbor);
			}
		}
	}

	// Handle components with cycles or nodes not visited
	for (const id of nodeIds) {
		if (layers[id] === undefined) {
			layers[id] = 0;
		}
	}

	// Group node IDs by layer index
	const layerGroups: Record<number, string[]> = {};
	for (const id of nodeIds) {
		const l = layers[id];
		if (!layerGroups[l]) layerGroups[l] = [];
		layerGroups[l].push(id);
	}

	// Setup layout configuration
	const startX = 80;
	const startY = 80;
	const colWidth = 360;
	const rowHeight = 260;

	// Record action in history stack for undo/redo support
	store.pushHistory();

	const updatedNodes = { ...store.nodes };
	const sortedLayers = Object.keys(layerGroups)
		.map(Number)
		.sort((a, b) => a - b);

	for (const layer of sortedLayers) {
		const idsInLayer = layerGroups[layer];
		idsInLayer.forEach((id, index) => {
			const node = updatedNodes[id];
			if (node) {
				// We don't lay out child nodes directly if they have parentId
				if (!node.parentId) {
					const newX = startX + layer * colWidth;
					const newY = startY + index * rowHeight;

					if (node.type === "group") {
						const dx = newX - node.x;
						const dy = newY - node.y;

						// Shift all member nodes in this group
						for (const cid of Object.keys(updatedNodes)) {
							if (updatedNodes[cid].parentId === node.id) {
								updatedNodes[cid] = {
									...updatedNodes[cid],
									x: updatedNodes[cid].x + dx,
									y: updatedNodes[cid].y + dy,
								};
							}
						}
					}

					updatedNodes[id] = {
						...node,
						x: newX,
						y: newY,
					};
				}
			}
		});
	}

	useCanvasStore.setState({ nodes: updatedNodes });
}
