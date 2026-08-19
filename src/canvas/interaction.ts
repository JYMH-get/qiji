/**
 * 画布交互状态（拖动节点 / 平移视口）——零依赖模块，供 store（去抖保存）与 command 层
 * （严格不重叠收口）无环引用地读取。
 *
 * 自动保存里有整项目 JSON.stringify + 提交哈希等主线程大活，撞上拖动/平移就是肉眼掉帧
 * （用户实测：卡顿都发生在"保存状态下拖动"）。保存不急这几百毫秒：交互期间一律推迟，松手再存。
 */
let _panning = false;

export const setCanvasPanning = (v: boolean) => {
	_panning = v;
};

export const isCanvasPanning = () => _panning;

/** 节点拖拽进行中（由 useCanvasDrag 打标；isDragHistoryPaused 即它的别名）。 */
let _nodeDragging = false;

export const setNodeDragging = (v: boolean) => {
	_nodeDragging = v;
};

export const isNodeDragging = () => _nodeDragging;
