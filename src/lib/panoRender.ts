/**
 * panoRender —— equirect 全景 → 透视视角的 WebGL 渲染器（零依赖，第194轮）。
 *
 * 一个全屏 quad + fragment shader 做「屏幕像素 → 相机射线 → 经纬 → equirect 采样」，
 * 交互查看与批量截图共用（比引入 three/Photo Sphere Viewer 轻两个数量级，dispose 简单）。
 * ⚠ 用 **WebGL2**：NPOT 纹理（2048×1024 等任意尺寸）在 GL1 下不能 REPEAT——
 * 水平 REPEAT 是全景左右无缝衔接采样的关键（lon 越界自动回卷）。
 */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = aPos;
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uYaw;   // 弧度
uniform float uPitch; // 弧度
uniform float uTanV;  // tan(垂直fov/2)
uniform float uTanH;  // uTanV * aspect
void main() {
	float cy = cos(uYaw), sy = sin(uYaw);
	float cp = cos(uPitch), sp = sin(uPitch);
	vec3 fwd = vec3(sy * cp, sp, cy * cp);
	vec3 right = normalize(vec3(cy, 0.0, -sy));
	// ⚠ up 不取负（第195轮修复）：clip space +y 即屏幕上方，取负=画面上下倒置
	// （中心像素不受 up 影响——四/六视图中心色测试抓不到这个 bug，回归须测非中心像素）
	vec3 up = cross(fwd, right);
	vec3 d = normalize(fwd + vUv.x * uTanH * right + vUv.y * uTanV * up);
	float lon = atan(d.x, d.z);            // -PI..PI（yaw=0 → 全景水平中央）
	float lat = asin(clamp(d.y, -1.0, 1.0));
	vec2 uv = vec2(lon / 6.28318530718 + 0.5, 0.5 - lat / 3.14159265359);
	outColor = texture(uTex, uv);
}`;

export class PanoRenderer {
	private gl: WebGL2RenderingContext;
	private program: WebGLProgram;
	private tex: WebGLTexture | null = null;
	private uYaw: WebGLUniformLocation;
	private uPitch: WebGLUniformLocation;
	private uTanV: WebGLUniformLocation;
	private uTanH: WebGLUniformLocation;

	constructor(public canvas: HTMLCanvasElement) {
		const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
		if (!gl) throw new Error("WebGL2 不可用（全景查看需要 WebGL2）");
		this.gl = gl;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`全景着色器编译失败：${gl.getShaderInfoLog(s)}`);
			return s;
		};
		const prog = gl.createProgram()!;
		gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
		gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`全景着色器链接失败：${gl.getProgramInfoLog(prog)}`);
		this.program = prog;
		gl.useProgram(prog);
		const buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // 超界三角覆盖全屏
		const loc = gl.getAttribLocation(prog, "aPos");
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		this.uYaw = gl.getUniformLocation(prog, "uYaw")!;
		this.uPitch = gl.getUniformLocation(prog, "uPitch")!;
		this.uTanV = gl.getUniformLocation(prog, "uTanV")!;
		this.uTanH = gl.getUniformLocation(prog, "uTanH")!;
	}

	/** 上传全景纹理（水平 REPEAT=左右无缝回卷、垂直 CLAMP） */
	setImage(img: ImageBitmap | HTMLImageElement): void {
		const gl = this.gl;
		if (this.tex) gl.deleteTexture(this.tex);
		this.tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	}

	/** 按当前 canvas 尺寸渲染指定视角（yaw/pitch 度、fov=垂直视场角度） */
	render(yawDeg: number, pitchDeg: number, fovDeg: number): void {
		const gl = this.gl;
		const w = this.canvas.width;
		const h = this.canvas.height;
		gl.viewport(0, 0, w, h);
		gl.useProgram(this.program);
		const tanV = Math.tan(((fovDeg * Math.PI) / 180) / 2);
		gl.uniform1f(this.uYaw, (yawDeg * Math.PI) / 180);
		gl.uniform1f(this.uPitch, (pitchDeg * Math.PI) / 180);
		gl.uniform1f(this.uTanV, tanV);
		gl.uniform1f(this.uTanH, tanV * (w / Math.max(1, h)));
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	destroy(): void {
		if (this.tex) this.gl.deleteTexture(this.tex);
		this.gl.getExtension("WEBGL_lose_context")?.loseContext(); // WebView2 WebGL context 有数量上限
	}
}

/** 离屏渲染一批视角为 PNG Blob（批量视图截取；每张同尺寸方图） */
export async function renderPanoSnapshots(
	img: ImageBitmap | HTMLImageElement,
	views: { yaw: number; pitch: number; fov: number }[],
	size = 1024,
): Promise<Blob[]> {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const r = new PanoRenderer(canvas);
	try {
		r.setImage(img);
		const out: Blob[] = [];
		for (const v of views) {
			r.render(v.yaw, v.pitch, v.fov);
			const blob = await new Promise<Blob>((resolve, reject) =>
				canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("视角导出失败"))), "image/png"),
			);
			out.push(blob);
		}
		return out;
	} finally {
		r.destroy();
	}
}
