/**
 * modelStage —— 可嵌入 3D 模型舞台（three.js 渲染层）。
 *
 * 三宿主共用一个类：独立导演台（网格地面）/ 涂鸦嵌入（底图背景）/ 720°全景嵌入
 * （equirect 背景，相机在球心）。⚠ 体积重（three ~600KB），只能被宿主组件
 * **动态 import**（App 根 lazy 弹窗内），绝不进主包静态图谱。
 *
 * 数据形态=src/lib/stageScene.ts 的场景 JSON（纯引用零位图）；骨骼定义与 FK
 * 凭 src/lib/pose3d/skeleton.ts 单一来源（渲染层按 JOINTS 搭 three 组层级，
 * 拖关节走 aimJointAt——两边数学一致）。
 *
 * 产物三件套：captureComposite（合成图）/ capturePose（OpenPose 姿势图）/
 * captureDepth（近白远黑深度图，相机近远裁剪面收紧到模型包围盒保证对比度）。
 * 关闭必须 destroy()（WEBGL_lose_context——WebView2 context 上限，全景同款）。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
	JOINTS,
	aimJointAt,
	openposeKeypoints,
	type FigurePose,
} from "./pose3d/skeleton";
import { drawOpenPoseFigure, type Point2 } from "./pose3d/openposeDraw";
import {
	sanitizeStageScene,
	type StageFigure,
	type StageModel,
	type StageProp,
	type StageSceneDoc,
} from "./stageScene";

export type StageBackground =
	| { mode: "stage" }
	| { mode: "image"; bitmap: ImageBitmap }
	| { mode: "pano"; bitmap: ImageBitmap };

/** 可被拖拽瞄准的关节（拖它=转它的父骨骼；肩/胯是刚性偏移不入列） */
export const DRAG_HANDLES = [
	"spine", "chest", "neck", "head",
	"elbowL", "wristL", "elbowR", "wristR",
	"kneeL", "ankleL", "kneeR", "ankleR",
];

const FIGURE_COLOR_DEFAULT = "#c8ccd8";
const PROP_COLOR_DEFAULT = "#8fa3c8";
/** 全景球对齐角：图像中央（u=0.5）落 +Z=yaw0（与 panoRender 一致；勿改，E2E 色带实锤） */
const PANO_SPHERE_ROTATION_Y = -Math.PI / 2;

interface FigureRig {
	root: THREE.Group;
	joints: Record<string, THREE.Group>;
	handles: THREE.Mesh[];
}

export interface StageModelPatch {
	pos?: [number, number, number];
	rot?: [number, number, number];
	scale?: number;
	/** 非等比拉伸倍率（本地 xyz，叠乘在 scale 上）；传 [1,1,1] 即清除 */
	stretch?: [number, number, number];
	name?: string;
	color?: string;
	pose?: FigurePose;
}

/** 选中框边拾取结果（拉边缩放/边滚轮旋转用，第207轮） */
export interface EdgePick {
	/** 边平行的世界轴（0=X 1=Y 2=Z） */
	axis: 0 | 1 | 2;
	/** 选中框中心（世界系） */
	center: [number, number, number];
}

export interface PickResult {
	type: "model" | "joint";
	modelId: string;
	jointName?: string;
	/** 命中点世界坐标 */
	point: THREE.Vector3;
}

export class ModelStage {
	readonly canvas: HTMLCanvasElement;
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	// 双相机（第208轮场景透视开关）：透视为主，正交按「目标距离处等效视野」换算视锥——
	// 切换时画面主体尺寸基本不变，只有近大远小消失。this.camera 恒指当前生效者。
	private persp: THREE.PerspectiveCamera;
	private orthoCam: THREE.OrthographicCamera;
	private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
	private aspect = 1;
	private raycaster = new THREE.Raycaster();
	private bg: StageBackground;
	private bgTexture: THREE.Texture | null = null;
	private grid: THREE.Object3D | null = null;
	private panoSphere: THREE.Mesh | null = null;
	private modelsGroup = new THREE.Group();
	private byId = new Map<string, { data: StageModel; obj: THREE.Object3D; rig?: FigureRig }>();
	private glbCache = new Map<string, THREE.Object3D>();
	private selBox: THREE.Box3Helper | null = null;
	private destroyed = false;

	selectedId: string | null = null;
	poseMode = false;
	/** 场景投影模式（stage/image 宿主可切；pano 恒透视——球面背景无正交语义） */
	projection: "persp" | "ortho" = "persp";
	onChange: (() => void) | null = null;

	// 轨道相机态（stage/image 模式）
	private orbit = { theta: 0, phi: 1.15, dist: 4.2, target: new THREE.Vector3(0, 0.9, 0) };
	// 全景视角态（pano 模式）
	pano = { yaw: 0, pitch: 0, fov: 75 };

	constructor(canvas: HTMLCanvasElement, bg: StageBackground) {
		this.canvas = canvas;
		this.bg = bg;
		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: true,
		});
		this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
		this.persp = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
		this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
		this.camera = this.persp;
		this.scene.add(this.modelsGroup);

		const hemi = new THREE.HemisphereLight(0xffffff, 0x445066, 1.1);
		const dir = new THREE.DirectionalLight(0xffffff, 1.6);
		dir.position.set(2.5, 5, 3);
		this.scene.add(hemi, dir);

		if (bg.mode === "stage") {
			const grid = new THREE.GridHelper(12, 24, 0x5a6a8a, 0x333c50);
			(grid.material as THREE.Material).transparent = true;
			(grid.material as THREE.Material).opacity = 0.6;
			this.grid = grid;
			this.scene.add(grid);
			this.scene.background = new THREE.Color(0x0b0e14);
		} else if (bg.mode === "image") {
			const tex = new THREE.Texture(bg.bitmap as unknown as HTMLImageElement);
			tex.colorSpace = THREE.SRGBColorSpace;
			// flipY 对 ImageBitmap 无效（同全景分支）——背景平面 v 反向，UV 变换翻回
			tex.flipY = false;
			tex.wrapS = THREE.ClampToEdgeWrapping;
			tex.wrapT = THREE.ClampToEdgeWrapping;
			tex.repeat.y = -1;
			tex.offset.y = 1;
			tex.needsUpdate = true;
			this.bgTexture = tex;
			this.scene.background = tex; // 屏幕铺满的 2D 背景（不参与 3D/深度）
		} else {
			// ⚠ 全景背景=内视球面网格，不用 scene.background 的 equirect 采样——three 的
			// equirectUv 用 atan(z,x)，与 panoRender 的 lon=atan(x,z) 是**镜像**关系，
			// backgroundRotation 转不回来（旋转救不了镜像）。球面 UV（u=0 在 -X、随 u 向
			// -Z 走）配 rotation.y=-π/2 后：u=0.5（图像中央）落 +Z、u 增大向 +X——与
			// panoRender「yaw0=+Z=图像中央、lon 正向=+X」逐点一致（推导+E2E 色带双验）。
			const tex = new THREE.Texture(bg.bitmap as unknown as HTMLImageElement);
			tex.colorSpace = THREE.SRGBColorSpace;
			// ⚠ 垂直翻转走 UV 变换而非 flipY（E2E 色带实锤）：flipY 对 ImageBitmap 源
			// **被规范忽略**；球面 UV 天顶=v1 采到图像底行=上下颠倒，repeat.y=-1 翻回
			// ——与 panoRender 的 uv.y=0.5-lat/π 对齐（天顶白/地底黑逐点验证）。
			tex.flipY = false;
			tex.wrapS = THREE.ClampToEdgeWrapping;
			tex.wrapT = THREE.ClampToEdgeWrapping;
			tex.repeat.y = -1;
			tex.offset.y = 1;
			tex.needsUpdate = true;
			this.bgTexture = tex;
			const sphere = new THREE.Mesh(
				new THREE.SphereGeometry(60, 64, 32),
				new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false }),
			);
			sphere.rotation.y = PANO_SPHERE_ROTATION_Y;
			sphere.renderOrder = -1;
			this.panoSphere = sphere;
			this.scene.add(sphere);
			this.scene.background = new THREE.Color(0x000000);
			this.camera.position.set(0, 0, 0);
			this.orbit.target.set(0, 0, 0);
		}
		this.updateCamera();
	}

	/* ───────────── 相机 ───────────── */

	private updateCamera(): void {
		if (this.bg.mode === "pano") {
			this.camera = this.persp; // 全景恒透视
			const yaw = (this.pano.yaw * Math.PI) / 180;
			const pitch = (this.pano.pitch * Math.PI) / 180;
			this.persp.fov = this.pano.fov;
			this.persp.aspect = this.aspect;
			this.camera.position.set(0, 0, 0);
			const cp = Math.cos(pitch);
			// 与 panoRender 同一约定：yaw=0 → +Z
			this.camera.lookAt(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
		} else {
			this.camera = this.projection === "ortho" ? this.orthoCam : this.persp;
			const { theta, phi, dist, target } = this.orbit;
			const sp = Math.sin(phi);
			this.camera.position.set(
				target.x + dist * sp * Math.sin(theta),
				target.y + dist * Math.cos(phi),
				target.z + dist * sp * Math.cos(theta),
			);
			this.camera.lookAt(target);
			if (this.camera === this.orthoCam) {
				// 正交视锥=目标距离处的透视等效视野：切换时主体尺寸不跳变；dist 变化仍有「缩放」手感
				const halfH = dist * Math.tan(((this.persp.fov / 2) * Math.PI) / 180);
				const halfW = halfH * this.aspect;
				this.orthoCam.left = -halfW;
				this.orthoCam.right = halfW;
				this.orthoCam.top = halfH;
				this.orthoCam.bottom = -halfH;
			} else {
				this.persp.aspect = this.aspect;
			}
		}
		this.camera.updateProjectionMatrix();
		// ⚠ 显式刷新世界矩阵（勿删）：切投影/改机位后未渲染前就 raycast（拾取/拉边/视平面交点）
		// 会用到陈旧 matrixWorld——E2E 平行光线断言实锤过（正交切换后首个 ray 全偏）。
		this.camera.updateMatrixWorld();
	}

	/** 场景透视开关（第208轮）：persp=透视（近大远小）/ ortho=正交（平行投影）。pano 宿主忽略。 */
	setProjection(mode: "persp" | "ortho"): void {
		if (this.bg.mode === "pano") return;
		this.projection = mode;
		this.updateCamera();
	}

	setPanoView(yawDeg: number, pitchDeg: number, fovDeg: number): void {
		this.pano.yaw = yawDeg;
		this.pano.pitch = Math.max(-89, Math.min(89, pitchDeg));
		this.pano.fov = Math.max(25, Math.min(110, fovDeg));
		this.updateCamera();
	}

	orbitBy(dx: number, dy: number): void {
		if (this.bg.mode === "pano") {
			this.setPanoView(this.pano.yaw - dx * 0.22 * (this.pano.fov / 60), this.pano.pitch + dy * 0.22 * (this.pano.fov / 60), this.pano.fov);
			return;
		}
		this.orbit.theta -= dx * 0.008;
		this.orbit.phi = Math.max(0.15, Math.min(Math.PI - 0.15, this.orbit.phi - dy * 0.008));
		this.updateCamera();
	}

	panBy(dx: number, dy: number): void {
		if (this.bg.mode === "pano") return;
		const scale = this.orbit.dist * 0.0016;
		const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
		this.orbit.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
		this.updateCamera();
	}

	dollyBy(factor: number): void {
		if (this.bg.mode === "pano") {
			this.setPanoView(this.pano.yaw, this.pano.pitch, this.pano.fov * factor);
			return;
		}
		this.orbit.dist = Math.max(0.6, Math.min(40, this.orbit.dist * factor));
		this.updateCamera();
	}

	getCameraState(): { theta: number; phi: number; dist: number; target: [number, number, number]; projection: "persp" | "ortho" } {
		const t = this.orbit.target;
		return { theta: this.orbit.theta, phi: this.orbit.phi, dist: this.orbit.dist, target: [t.x, t.y, t.z], projection: this.projection };
	}

	setCameraState(s: Partial<{ theta: number; phi: number; dist: number; target: [number, number, number]; projection: "persp" | "ortho" }>): void {
		if (typeof s.theta === "number" && Number.isFinite(s.theta)) this.orbit.theta = s.theta;
		if (typeof s.phi === "number" && Number.isFinite(s.phi)) this.orbit.phi = Math.max(0.15, Math.min(Math.PI - 0.15, s.phi));
		if (typeof s.dist === "number" && Number.isFinite(s.dist)) this.orbit.dist = Math.max(0.6, Math.min(40, s.dist));
		if (Array.isArray(s.target) && s.target.length === 3) this.orbit.target.set(s.target[0], s.target[1], s.target[2]);
		if (s.projection === "persp" || s.projection === "ortho") this.projection = s.projection;
		this.updateCamera();
	}

	/* ───────────── 场景增删改 ───────────── */

	async setSceneDoc(
		raw: unknown,
		glbBytes?: (assetId: string) => Promise<ArrayBuffer | null>,
	): Promise<void> {
		const doc = sanitizeStageScene(raw);
		for (const { obj } of this.byId.values()) this.modelsGroup.remove(obj);
		this.byId.clear();
		for (const m of doc.models) await this.addModel(m, glbBytes);
		this.setSelected(null);
	}

	getSceneDoc(): StageSceneDoc {
		return { models: [...this.byId.values()].map((e) => JSON.parse(JSON.stringify(e.data)) as StageModel) };
	}

	async addModel(
		m: StageModel,
		glbBytes?: (assetId: string) => Promise<ArrayBuffer | null>,
	): Promise<boolean> {
		if (this.byId.has(m.id)) return false;
		let obj: THREE.Object3D;
		let rig: FigureRig | undefined;
		if (m.kind === "figure") {
			rig = buildFigure(m);
			obj = rig.root;
		} else if (m.kind === "prop") {
			obj = buildProp(m);
		} else {
			let tpl = this.glbCache.get(m.assetId) ?? null;
			if (!tpl && glbBytes) {
				const bytes = await glbBytes(m.assetId);
				if (bytes) tpl = await parseGlb(bytes);
				if (tpl) this.glbCache.set(m.assetId, tpl);
			}
			if (!tpl) return false; // 字节取不到：跳过（不建占位防幽灵）
			obj = tpl.clone(true);
		}
		obj.position.set(...m.pos);
		obj.rotation.set(
			(m.rot[0] * Math.PI) / 180,
			(m.rot[1] * Math.PI) / 180,
			(m.rot[2] * Math.PI) / 180,
		);
		applyObjScale(obj, m);
		obj.userData.modelId = m.id;
		this.modelsGroup.add(obj);
		this.byId.set(m.id, { data: JSON.parse(JSON.stringify(m)) as StageModel, obj, rig });
		this.onChange?.();
		return true;
	}

	removeModel(id: string): void {
		const e = this.byId.get(id);
		if (!e) return;
		this.modelsGroup.remove(e.obj);
		this.byId.delete(id);
		if (this.selectedId === id) this.setSelected(null);
		this.onChange?.();
	}

	listModels(): StageModel[] {
		return [...this.byId.values()].map((e) => e.data);
	}

	getModel(id: string): StageModel | null {
		return this.byId.get(id)?.data ?? null;
	}

	/** 更新模型变换/外观/姿势（patch 只带要改的键） */
	updateModel(id: string, patch: StageModelPatch): void {
		const e = this.byId.get(id);
		if (!e) return;
		const d = e.data;
		if (patch.pos) { d.pos = [...patch.pos]; e.obj.position.set(...patch.pos); }
		if (patch.rot) {
			d.rot = [...patch.rot];
			e.obj.rotation.set((patch.rot[0] * Math.PI) / 180, (patch.rot[1] * Math.PI) / 180, (patch.rot[2] * Math.PI) / 180);
		}
		if (typeof patch.scale === "number") { d.scale = patch.scale; applyObjScale(e.obj, d); }
		if (patch.stretch) {
			const s = patch.stretch.map((n) => Math.min(20, Math.max(0.05, Number.isFinite(n) ? n : 1))) as [number, number, number];
			if (s.every((n) => Math.abs(n - 1) < 0.005)) delete d.stretch; // ≈[1,1,1] 清除（与 sanitizeStretch 同阈值）
			else d.stretch = s;
			applyObjScale(e.obj, d);
		}
		if (typeof patch.name === "string") d.name = patch.name;
		if (typeof patch.color === "string" && d.kind !== "glb") {
			d.color = patch.color;
			e.obj.traverse((o) => {
				const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
				if (mat instanceof THREE.MeshStandardMaterial) mat.color.set(patch.color!);
			});
		}
		if (patch.pose && e.rig && d.kind === "figure") {
			d.pose = patch.pose;
			applyPoseToRig(e.rig, patch.pose);
		}
		this.refreshSelBox();
		this.onChange?.();
	}

	/* ───────────── 选中与拾取 ───────────── */

	setSelected(id: string | null): void {
		this.selectedId = id;
		if (this.selBox) { this.scene.remove(this.selBox); this.selBox = null; }
		for (const e of this.byId.values()) {
			if (e.rig) setHandlesVisible(e.rig, this.poseMode && e.data.id === id);
		}
		this.refreshSelBox();
		this.onChange?.();
	}

	setPoseMode(on: boolean): void {
		this.poseMode = on;
		for (const e of this.byId.values()) {
			if (e.rig) setHandlesVisible(e.rig, on && e.data.id === this.selectedId);
		}
		this.onChange?.();
	}

	private refreshSelBox(): void {
		if (this.selBox) { this.scene.remove(this.selBox); this.selBox = null; }
		const e = this.selectedId ? this.byId.get(this.selectedId) : null;
		if (!e) return;
		const box = new THREE.Box3().setFromObject(e.obj);
		if (box.isEmpty()) return;
		this.selBox = new THREE.Box3Helper(box, new THREE.Color(0x22d3ee));
		this.scene.add(this.selBox);
	}

	/** 拾取：优先关节手柄（姿势模式），其次模型本体。坐标=canvas 内像素。 */
	pick(px: number, py: number): PickResult | null {
		const ndc = this.toNdc(px, py);
		this.raycaster.setFromCamera(ndc, this.camera);
		if (this.poseMode && this.selectedId) {
			const e = this.byId.get(this.selectedId);
			if (e?.rig) {
				const hits = this.raycaster.intersectObjects(e.rig.handles, false);
				if (hits[0]) {
					return {
						type: "joint",
						modelId: this.selectedId,
						jointName: hits[0].object.userData.jointName as string,
						point: hits[0].point,
					};
				}
			}
		}
		const hits = this.raycaster.intersectObjects(this.modelsGroup.children, true);
		for (const h of hits) {
			let o: THREE.Object3D | null = h.object;
			while (o && !o.userData.modelId) o = o.parent;
			if (o?.userData.modelId) return { type: "model", modelId: o.userData.modelId as string, point: h.point };
		}
		return null;
	}

	/**
	 * 选中框边拾取（第207轮）：把选中模型世界 AABB 的 12 条边投影到屏幕，找距指针 ≤threshold px
	 * 的最近边，返回其平行的世界轴与框中心。用于 拉边=缩放 / 边上滚轮=绕该边轴旋转。
	 */
	edgePick(px: number, py: number, threshold = 10): EdgePick | null {
		const e = this.selectedId ? this.byId.get(this.selectedId) : null;
		if (!e) return null;
		const box = new THREE.Box3().setFromObject(e.obj);
		if (box.isEmpty()) return null;
		this.camera.updateMatrixWorld();
		const w = this.canvas.clientWidth || this.canvas.width;
		const h = this.canvas.clientHeight || this.canvas.height;
		const proj = (v: THREE.Vector3): { x: number; y: number } | null => {
			const cam = v.clone().applyMatrix4(this.camera.matrixWorldInverse);
			if (cam.z > -0.01) return null; // 相机背后不参与
			const p = v.clone().project(this.camera);
			return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
		};
		let best: { axis: 0 | 1 | 2; d: number } | null = null;
		for (let axis = 0; axis < 3; axis++) {
			const fixed = [0, 1, 2].filter((a) => a !== axis) as [number, number];
			for (const s1 of [0, 1]) for (const s2 of [0, 1]) {
				const a = new THREE.Vector3();
				const b = new THREE.Vector3();
				a.setComponent(axis, box.min.getComponent(axis));
				b.setComponent(axis, box.max.getComponent(axis));
				for (const v of [a, b]) {
					v.setComponent(fixed[0], s1 ? box.max.getComponent(fixed[0]) : box.min.getComponent(fixed[0]));
					v.setComponent(fixed[1], s2 ? box.max.getComponent(fixed[1]) : box.min.getComponent(fixed[1]));
				}
				const pa = proj(a);
				const pb = proj(b);
				if (!pa || !pb) continue;
				const d = distToSegment2D(px, py, pa, pb);
				if (d <= threshold && (!best || d < best.d)) best = { axis: axis as 0 | 1 | 2, d };
			}
		}
		if (!best) return null;
		const c = box.getCenter(new THREE.Vector3());
		return { axis: best.axis, center: [c.x, c.y, c.z] };
	}

	/** 世界轴 → 该模型本地主导轴（模型有旋转时，世界 AABB 的边轴对应到最接近的本地轴） */
	worldAxisToLocalAxis(id: string, axis: 0 | 1 | 2): 0 | 1 | 2 {
		const e = this.byId.get(id);
		if (!e) return axis;
		const v = new THREE.Vector3();
		v.setComponent(axis, 1);
		v.applyQuaternion(e.obj.getWorldQuaternion(new THREE.Quaternion()).invert());
		const abs = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
		return abs.indexOf(Math.max(...abs)) as 0 | 1 | 2;
	}

	/** 指针射线与「过 anchor 的水平面」交点（模型拖动用）；无交返回 null */
	rayOnHorizontal(px: number, py: number, anchorY: number): THREE.Vector3 | null {
		this.raycaster.setFromCamera(this.toNdc(px, py), this.camera);
		const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -anchorY);
		const out = new THREE.Vector3();
		return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
	}

	/** 指针射线与「过 anchor 的相机正对面」交点（关节拖拽用） */
	rayOnViewPlane(px: number, py: number, anchor: THREE.Vector3): THREE.Vector3 | null {
		this.raycaster.setFromCamera(this.toNdc(px, py), this.camera);
		const normal = new THREE.Vector3();
		this.camera.getWorldDirection(normal);
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
		const out = new THREE.Vector3();
		return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
	}

	/** rayOnViewPlane 的纯数组版（宿主组件不静态引 three，拉边缩放用） */
	rayOnViewPlanePoint(px: number, py: number, anchor: [number, number, number]): [number, number, number] | null {
		const v = this.rayOnViewPlane(px, py, new THREE.Vector3(...anchor));
		return v ? [v.x, v.y, v.z] : null;
	}

	/** 拖关节：目标点（世界系）→ 换算人偶本地 → aimJointAt → 应用父关节旋转 */
	dragJointTo(modelId: string, jointName: string, worldTarget: THREE.Vector3): void {
		const e = this.byId.get(modelId);
		if (!e?.rig || e.data.kind !== "figure") return;
		const local = e.obj.worldToLocal(worldTarget.clone());
		const r = aimJointAt(e.data.pose, jointName, [local.x, local.y, local.z]);
		if (!r) return;
		const pose: FigurePose = { ...e.data.pose, [r.joint]: r.euler };
		this.updateModel(modelId, { pose });
	}

	jointWorldPos(modelId: string, jointName: string): THREE.Vector3 | null {
		const e = this.byId.get(modelId);
		const g = e?.rig?.joints[jointName];
		if (!g) return null;
		return g.getWorldPosition(new THREE.Vector3());
	}

	private toNdc(px: number, py: number): THREE.Vector2 {
		const w = this.canvas.clientWidth || this.canvas.width;
		const h = this.canvas.clientHeight || this.canvas.height;
		return new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1);
	}

	/* ───────────── 渲染与产物 ───────────── */

	setSize(w: number, h: number): void {
		this.renderer.setSize(w, h, false);
		this.aspect = w / h;
		this.updateCamera();
	}

	render(): void {
		if (this.destroyed) return;
		this.renderer.render(this.scene, this.camera);
	}

	/** 合成图（背景+模型；transparentBg=true 时只出模型层，供涂鸦叠回原图） */
	async captureComposite(w: number, h: number, transparentBg = false): Promise<Blob> {
		return this.captureWith(w, h, () => {
			if (transparentBg) {
				const oldBg = this.scene.background;
				this.scene.background = null;
				if (this.grid) this.grid.visible = false;
				if (this.panoSphere) this.panoSphere.visible = false;
				this.renderer.setClearColor(0x000000, 0);
				this.renderer.render(this.scene, this.camera);
				this.scene.background = oldBg;
				if (this.grid) this.grid.visible = true;
				if (this.panoSphere) this.panoSphere.visible = true;
			} else {
				this.renderer.render(this.scene, this.camera);
			}
		});
	}

	/** OpenPose 姿势图（黑底；全部人偶；与当前相机一致） */
	async capturePose(w: number, h: number): Promise<Blob> {
		const out = document.createElement("canvas");
		out.width = w;
		out.height = h;
		const ctx = out.getContext("2d")!;
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, w, h);
		const oldAspect = this.aspect;
		this.aspect = w / h;
		this.updateCamera();
		this.camera.updateMatrixWorld();
		const inv = this.camera.matrixWorldInverse;
		for (const e of this.byId.values()) {
			if (e.data.kind !== "figure") continue;
			const kps = openposeKeypoints(e.data.pose);
			const pts: Point2[] = kps.map(([x, y, z]) => {
				const world = e.obj.localToWorld(new THREE.Vector3(x, y, z));
				const camSpace = world.clone().applyMatrix4(inv);
				if (camSpace.z > -0.01) return null; // 相机背后
				const p = world.project(this.camera);
				return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
			});
			drawOpenPoseFigure(ctx, pts, Math.max(2, Math.min(w, h) * 0.006));
		}
		this.aspect = oldAspect;
		this.updateCamera();
		return new Promise<Blob>((resolve, reject) =>
			out.toBlob((b) => (b ? resolve(b) : reject(new Error("姿势图导出失败"))), "image/png"),
		);
	}

	/** 深度图（近白远黑；只含模型，近远裁剪面收紧到模型包围盒） */
	async captureDepth(w: number, h: number): Promise<Blob> {
		return this.captureWith(w, h, () => {
			const box = new THREE.Box3();
			for (const e of this.byId.values()) box.expandByObject(e.obj);
			const oldBg = this.scene.background;
			const oldNear = this.camera.near;
			const oldFar = this.camera.far;
			if (!box.isEmpty()) {
				// 沿视线方向收紧 near/far（提高深度对比度）
				const dir = new THREE.Vector3();
				this.camera.getWorldDirection(dir);
				const camPos = this.camera.getWorldPosition(new THREE.Vector3());
				let min = Infinity;
				let max = -Infinity;
				for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
					const d = new THREE.Vector3(cx, cy, cz).sub(camPos).dot(dir);
					min = Math.min(min, d);
					max = Math.max(max, d);
				}
				this.camera.near = Math.max(0.02, min - 0.2);
				this.camera.far = Math.max(this.camera.near + 0.5, max + 0.2);
				this.camera.updateProjectionMatrix();
			}
			this.scene.background = null;
			if (this.grid) this.grid.visible = false;
			if (this.panoSphere) this.panoSphere.visible = false;
			if (this.selBox) this.selBox.visible = false;
			const override = new THREE.MeshDepthMaterial();
			this.scene.overrideMaterial = override;
			this.renderer.setClearColor(0x000000, 1);
			this.renderer.render(this.scene, this.camera);
			this.scene.overrideMaterial = null;
			override.dispose();
			this.scene.background = oldBg;
			if (this.grid) this.grid.visible = true;
			if (this.panoSphere) this.panoSphere.visible = true;
			if (this.selBox) this.selBox.visible = true;
			this.camera.near = oldNear;
			this.camera.far = oldFar;
			this.camera.updateProjectionMatrix();
		});
	}

	private async captureWith(w: number, h: number, draw: () => void): Promise<Blob> {
		const oldW = this.canvas.width;
		const oldH = this.canvas.height;
		const oldAspect = this.aspect;
		const oldPr = this.renderer.getPixelRatio();
		this.renderer.setPixelRatio(1);
		this.renderer.setSize(w, h, false);
		this.aspect = w / h;
		this.updateCamera();
		const hideHandles: THREE.Mesh[] = [];
		for (const e of this.byId.values()) {
			if (e.rig) for (const hm of e.rig.handles) if (hm.visible) { hm.visible = false; hideHandles.push(hm); }
		}
		const selWasVisible = this.selBox?.visible ?? false;
		if (this.selBox) this.selBox.visible = false;
		draw();
		const blob = await new Promise<Blob>((resolve, reject) =>
			this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("渲染导出失败"))), "image/png"),
		);
		for (const hm of hideHandles) hm.visible = true;
		if (this.selBox) this.selBox.visible = selWasVisible;
		this.renderer.setPixelRatio(oldPr);
		this.renderer.setSize(oldW / oldPr, oldH / oldPr, false);
		this.aspect = oldAspect;
		this.updateCamera();
		this.render();
		return blob;
	}

	destroy(): void {
		this.destroyed = true;
		this.bgTexture?.dispose();
		this.renderer.dispose();
		try {
			this.renderer.getContext()?.getExtension("WEBGL_lose_context")?.loseContext();
		} catch { /* 已丢即忽略 */ }
	}
}

/* ───────────── 模型搭建 ───────────── */

/** scale × stretch 叠乘落到 obj.scale（等比+非等比统一入口） */
function applyObjScale(obj: THREE.Object3D, m: StageModel): void {
	const st = m.stretch ?? [1, 1, 1];
	obj.scale.set(m.scale * st[0], m.scale * st[1], m.scale * st[2]);
}

/** 2D 点到线段距离（edgePick 屏幕空间用） */
function distToSegment2D(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
	return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function matOf(color: string | undefined, fallback: string): THREE.MeshStandardMaterial {
	return new THREE.MeshStandardMaterial({ color: color || fallback, roughness: 0.75, metalness: 0.05 });
}

/** 人偶：按 JOINTS 单一来源搭 three 组层级（组=关节，几何=骨骼/关节可视化） */
function buildFigure(m: StageFigure): FigureRig {
	const mat = matOf(m.color, FIGURE_COLOR_DEFAULT);
	const handleMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.9 });
	const joints: Record<string, THREE.Group> = {};
	const handles: THREE.Mesh[] = [];
	let root: THREE.Group | null = null;
	for (const j of JOINTS) {
		const g = new THREE.Group();
		g.position.set(...j.offset);
		joints[j.name] = g;
		if (j.parent) joints[j.parent].add(g);
		else root = g;
		// 骨骼可视化：关节到父的连接柱（挂在父组内指向本关节）
		if (j.parent) {
			const len = Math.hypot(...j.offset);
			if (len > 0.03) {
				const isCore = ["spine", "chest", "neck"].includes(j.name);
				const r = isCore ? 0.055 : j.parent === "head" ? 0.008 : 0.032;
				const bone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.85, len, 10), mat);
				// 圆柱默认沿 +Y：转到 offset 方向、置于中点
				bone.position.set(j.offset[0] / 2, j.offset[1] / 2, j.offset[2] / 2);
				bone.quaternion.setFromUnitVectors(
					new THREE.Vector3(0, 1, 0),
					new THREE.Vector3(...j.offset).normalize(),
				);
				joints[j.parent].add(bone);
			}
		}
		// 关节球（标记点不画）
		if (j.editable) {
			const ball = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), mat);
			g.add(ball);
		}
	}
	// 头
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), mat);
	head.position.set(0, 0.1, 0.01);
	head.scale.set(0.82, 1, 0.9);
	joints.head.add(head);
	// 鼻尖小凸（辨面向）
	const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), mat);
	noseTip.position.set(0, 0.09, 0.095);
	joints.head.add(noseTip);
	// 躯干体
	const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.28, 4, 12), mat);
	torso.position.set(0, 0.24, 0);
	torso.scale.set(1.25, 1, 0.72);
	joints.hips.add(torso);
	// 拖拽手柄（默认隐藏，姿势模式+选中才显示）
	for (const name of DRAG_HANDLES) {
		const hm = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), handleMat);
		hm.userData.jointName = name;
		hm.visible = false;
		hm.renderOrder = 999;
		joints[name].add(hm);
		handles.push(hm);
	}
	applyPoseToRig({ root: root!, joints, handles }, m.pose);
	return { root: root!, joints, handles };
}

function applyPoseToRig(rig: FigureRig, pose: FigurePose): void {
	for (const j of JOINTS) {
		if (!j.editable) continue;
		const e = pose[j.name];
		const g = rig.joints[j.name];
		if (e) g.rotation.set((e[0] * Math.PI) / 180, (e[1] * Math.PI) / 180, (e[2] * Math.PI) / 180);
		else g.rotation.set(0, 0, 0);
	}
}

function setHandlesVisible(rig: FigureRig, on: boolean): void {
	for (const h of rig.handles) h.visible = on;
}

function buildProp(m: StageProp): THREE.Object3D {
	const mat = matOf(m.color, PROP_COLOR_DEFAULT);
	const size = m.size ?? [1, 1, 1];
	let geo: THREE.BufferGeometry;
	switch (m.shape) {
		case "sphere": geo = new THREE.SphereGeometry(0.5, 24, 18); break;
		case "cylinder": geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24); break;
		case "cone": geo = new THREE.ConeGeometry(0.5, 1, 24); break;
		case "plane": {
			geo = new THREE.BoxGeometry(1, 0.02, 1);
			break;
		}
		default: geo = new THREE.BoxGeometry(1, 1, 1);
	}
	const mesh = new THREE.Mesh(geo, mat);
	mesh.scale.set(size[0], size[1], size[2]);
	const wrap = new THREE.Group();
	wrap.add(mesh);
	return wrap;
}

async function parseGlb(bytes: ArrayBuffer): Promise<THREE.Object3D | null> {
	try {
		const loader = new GLTFLoader();
		const gltf = await loader.parseAsync(bytes, "");
		const obj = gltf.scene;
		// 过大/过小的模型归一到 ~1.6m（人物尺度），保留用户 scale 再调
		const box = new THREE.Box3().setFromObject(obj);
		const dim = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(dim.x, dim.y, dim.z);
		if (maxDim > 0 && (maxDim > 8 || maxDim < 0.1)) {
			obj.scale.multiplyScalar(1.6 / maxDim);
		}
		// 底部落地、水平居中
		const box2 = new THREE.Box3().setFromObject(obj);
		const c = box2.getCenter(new THREE.Vector3());
		obj.position.x -= c.x;
		obj.position.z -= c.z;
		obj.position.y -= box2.min.y;
		const wrap = new THREE.Group();
		wrap.add(obj);
		return wrap;
	} catch {
		return null;
	}
}
