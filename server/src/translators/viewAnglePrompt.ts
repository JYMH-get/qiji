/**
 * viewAnglePrompt —— 「转视角」提示词的**服务端**渲染（第193轮：用户要求提示词对客户端不可见）。
 *
 * 客户端只传机位参数（GenerateRequest.params.viewAngle = {az,el,shot,panX,panY,lens,custom}），
 * buildPrompt 按 purpose "image.viewangle" 进本模块：
 *  - 机位/俯仰/景别/平移/镜头短语 = 参数化文本（本文件代码；⚠ 第192轮教训勿回退：
 *    **纯镜头语言**，绝不用「背面/人物/发型/服装」等拟人措辞——无人场景会被诱导凭空造人）；
 *  - 主骨架 + 未见区域条款 = 管理端「提示词模板」库（viewangle.main / .backfill.far / .backfill.mid，
 *    分类「转视角」可调优；catalog 对 viewangle.* 连 bodyPreview 都不下发）。模板被删/清空时用
 *    本文件 FALLBACK 兜底，功能永不断。
 */
import { getTemplateDef } from "../store/templates.ts";

export interface ViewAngleParams {
	az: number;
	el: number;
	shot: number;
	panX: number;
	panY: number;
	lens?: "fisheye" | "dutch";
	custom?: string;
}

const SHOT_LABELS = ["特写", "近景", "中景", "全景", "远景"];

/** 参数清洗：形状不对返回 null（调用方回退普通提示词路径）；数值夹取、custom 截断防滥用 */
export function sanitizeViewAngle(raw: unknown): ViewAngleParams | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
	const az = num(o.az);
	if (Number.isNaN(az)) return null;
	const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
	return {
		az: ((Math.round(az) % 360) + 360) % 360,
		el: clamp(Math.round(num(o.el) || 0), -90, 90),
		shot: clamp(Math.round(num(o.shot) || 2), 0, SHOT_LABELS.length - 1),
		panX: clamp(Math.round(num(o.panX) || 0), -100, 100),
		panY: clamp(Math.round(num(o.panY) || 0), -100, 100),
		lens: o.lens === "fisheye" || o.lens === "dutch" ? o.lens : undefined,
		custom: typeof o.custom === "string" ? o.custom.trim().slice(0, 500) : undefined,
	};
}

/** 归一化到 (-180, 180]（0=正面；正=右、负=左） */
function normalizeAz(az: number): number {
	let a = ((az % 360) + 360) % 360;
	if (a > 180) a -= 360;
	return a;
}

/** 水平环绕 → 机位短语（纯镜头语言） */
function azimuthPhrase(az: number): string {
	const a = normalizeAz(az);
	if (a === 0) return "相机保持在原拍摄位置，正对场景拍摄";
	if (Math.abs(a) === 180) {
		return "相机绕场景中心水平环绕180度，移动到场景的正后方位置，镜头转向回望原拍摄方向——从场景的另一侧往回拍";
	}
	const side = a > 0 ? "右" : "左";
	const deg = Math.abs(a);
	if (deg === 90) return `相机水平环绕到场景正${side}侧90度的位置，镜头对准场景中心`;
	if (deg < 90) return `相机绕场景中心向${side}水平移动${deg}度（${side}前方机位），镜头始终对准场景中心`;
	return `相机绕场景中心向${side}水平移动${deg}度，越过正侧面到达${side}后方机位，镜头回望场景中心`;
}

/** 垂直俯仰 → 机位短语 */
function elevationPhrase(el: number): string {
	if (el === 0) return "相机保持平视高度";
	if (el > 0) return `相机升高为高机位，俯视${el}度向下拍摄`;
	return `相机降低为低机位，仰视${-el}度向上拍摄`;
}

/** 相机平移取景（WASD）→ 构图短语（按画面结果反向描述）；8% 内居中忽略、8–22% 轻微、以上明显 */
function panPhrase(panX: number, panY: number): string | null {
	const grade = (v: number) => (Math.abs(v) < 8 ? 0 : Math.abs(v) < 22 ? 1 : 2);
	const gx = grade(panX);
	const gy = grade(panY);
	if (!gx && !gy) return null;
	const dir: string[] = [];
	if (gx) dir.push(panX > 0 ? "左" : "右");
	if (gy) dir.push(panY > 0 ? "上" : "下");
	const strength = Math.max(gx, gy) === 2 ? "明显" : "略微";
	return `构图上画面内容整体${strength}偏向画面${dir.join("")}方（相机取景窗反向平移所致），另一侧留出相应空间`;
}

function lensPhrase(lens?: ViewAngleParams["lens"]): string | null {
	if (lens === "fisheye") return "使用鱼眼超广角镜头，画面带明显的桶形畸变";
	if (lens === "dutch") return "采用荷兰角构图（画面明显倾斜，制造张力）";
	return null;
}

/** {{变量}} 填充（本地实现避免与 prompt.ts 循环依赖） */
function fill(body: string, vars: Record<string, string>): string {
	return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name: string) => vars[name.trim()] ?? "");
}

/** 模板正文（管理端权威）；被删/清空/禁用时回退代码默认值 */
function tplBody(id: string, fallback: string): string {
	const t = getTemplateDef(id);
	return t && t.enabled && t.body.trim() ? t.body : fallback;
}

const FALLBACK_MAIN =
	"把 @Image1 的场景改为新的相机机位重新拍摄同一画面：{{机位描述}}。" +
	"画面内容必须还是原图中的同一场景：原图里已有的一切（场景、物体，如有人物也包括人物）" +
	"保持形态、材质、光照氛围与相互空间位置关系完全一致，不添加、不删除、不改变任何内容，" +
	"只改变相机的位置、朝向与构图，输出与原图同一画风的连贯画面。{{未见区域}}{{补充要求}}";
const FALLBACK_FAR =
	"注意：新机位下画面的大部分区域在原图中被遮挡或没有拍到（各物体的背侧、场景的另一面）——" +
	"请根据原图中各物体的形状、材质、结构与空间布局，推理并连贯地生成这些未见区域；" +
	"构图必须符合新机位（前后关系相应反转），不要沿用原图的正面构图；" +
	"画面里只能出现原图中已有的物体，绝不要凭空添加原图中不存在的物体或人物。";
const FALLBACK_MID =
	"注意：新机位包含部分原图未拍到的侧后区域，请按原图各物体的结构与空间布局合理补全，" +
	"与可见部分自然衔接；绝不要凭空添加原图中不存在的物体或人物。";

/** 机位参数 → 完整提示词；参数形状不对返回 null（buildPrompt 走普通路径兜底） */
export function renderViewAnglePrompt(raw: unknown): string | null {
	const p = sanitizeViewAngle(raw);
	if (!p) return null;
	const parts = [azimuthPhrase(p.az), elevationPhrase(p.el), `景别调整为${SHOT_LABELS[p.shot]}`];
	const pan = panPhrase(p.panX, p.panY);
	if (pan) parts.push(pan);
	const lens = lensPhrase(p.lens);
	if (lens) parts.push(lens);
	const absAz = Math.abs(normalizeAz(p.az));
	const back = absAz >= 135
		? tplBody("viewangle.backfill.far", FALLBACK_FAR)
		: absAz > 90 ? tplBody("viewangle.backfill.mid", FALLBACK_MID) : "";
	return fill(tplBody("viewangle.main", FALLBACK_MAIN), {
		机位描述: parts.join("；"),
		未见区域: back,
		补充要求: p.custom ? `补充要求：${p.custom}。` : "",
	});
}
