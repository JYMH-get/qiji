import type { ModelAdapter, PollResult } from "./types";
import { num, printLLMRequest, printLLMResponse, printLLMError } from "./utils";

/**
 * Seedance 2.0 — 视频节点适配器（直连简梦 JA API）
 *
 * 用户端根据分辨率自动选择具体模型版本：
 *   480p → JA-sd2-fast-480
 *   720p → JA-sd2-fast-720
 *   1080p → JA-sd2-pro-1080p
 *
 * API 密钥从 settingsStore 读取，存储于本地。
 * 资产 ID 通过 Catbox 上传为公网 URL 后提交。
 */

const JIANMENG_API_BASE = "https://api.jian1.vip";

/** 分辨率 → 简梦模型版本映射 */
function resolveJianmengModel(resolution: string): string {
  const res = (resolution || "480p").toLowerCase();
  if (res.includes("1080")) return "JA-sd2-pro-1080p";
  if (res.includes("720")) return "JA-sd2-fast-720";
  return "JA-sd2-fast-480";
}

/** 宽高比标准化 */
function normalizeAR(ar: string): string {
  if (ar.includes("16:9") || ar.includes("横屏")) return "16:9";
  if (ar.includes("9:16") || ar.includes("竖屏")) return "9:16";
  if (ar.includes("1:1") || ar.includes("方形")) return "1:1";
  if (ar.includes("21:9")) return "21:9";
  if (ar.includes("3:4")) return "3:4";
  if (ar.includes("4:3")) return "4:3";
  return "16:9";
}

/** 将 asset ID（本地 dataURL / blob URL）上传到 Catbox 获取公网 URL */
async function uploadToCatbox(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  try {
    let blob: Blob;
    if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return url;
      const binary = atob(match[2]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: match[1] });
    } else {
      const res = await fetch(url);
      blob = await res.blob();
    }

    const ext = blob.type.includes("video") ? "mp4" : blob.type.includes("image") ? "png" : "bin";
    const formData = new FormData();
    formData.append("reqtype", "fileupload");
    formData.append("fileToUpload", blob, `qiji_${Date.now()}.${ext}`);

    const res = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`Catbox upload failed: ${res.status}`);
    const publicUrl = (await res.text()).trim();
    console.log(`[Catbox] Uploaded → ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error("[Catbox] Upload failed:", err);
    return url;
  }
}

/** 本地任务跟踪（内存） */
const localTasks = new Map<string, {
  externalId: string;
  status: string;
  progress: number;
  resultUri?: string;
  error?: string;
}>();

export const seedanceAdapter: ModelAdapter = {
  key: "seedance-2",
  displayName: "Seedance 2.0",
  vendor: "字节跳动 / 简梦",
  nodeTypes: ["video"],
  baseCost: 9,
  modes: [
    {
      key: "text2video",
      label: "文生视频",
      inputHint: "输入视频描述提示词，支持在文本中插入 @Image1, @Video1, @Audio1 等引用素材...",
      paramsSchema: [
        { key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p（标清）", "1080p（高清）"], default: "480p" },
        { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）", "21:9", "3:4", "4:3"], default: "横屏（16:9）" },
        { key: "duration", label: "时长", type: "number", min: 4, max: 15, step: 1, default: 4, unit: "s" },
      ],
    },
    {
      key: "motion-imitation",
      label: "动作模仿",
      inputHint: "上传一段参考视频，AI 将模仿其中的动作生成新视频...",
      paramsSchema: [
        { key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p（标清）", "1080p（高清）"], default: "480p" },
        { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"], default: "横屏（16:9）" },
        { key: "duration", label: "时长", type: "number", min: 4, max: 15, step: 1, default: 4, unit: "s" },
      ],
    },
    {
      key: "all-reference",
      label: "全能参考",
      inputHint: "多图/角色库参考生成，在提示词中用 @Image1 @Video1 @Audio1 引用素材...",
      paramsSchema: [
        { key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p（标清）", "1080p（高清）"], default: "480p" },
        { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"], default: "横屏（16:9）" },
        { key: "duration", label: "时长", type: "number", min: 4, max: 15, step: 1, default: 4, unit: "s" },
      ],
    },
    {
      key: "video-edit",
      label: "视频编辑",
      inputHint: "对已有视频进行风格转换、重绘或编辑...",
      paramsSchema: [
        { key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p（标清）", "1080p（高清）"], default: "480p" },
        { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"], default: "横屏（16:9）" },
        { key: "duration", label: "时长", type: "number", min: 4, max: 15, step: 1, default: 4, unit: "s" },
      ],
    },
  ],
  estimateCost(_modeKey, params) {
    const res = (params.resolution as string) || "480p";
    const dur = num(params, "duration", 4);
    if (res === "1080p（高清）") return dur * 20;
    if (res === "720p（标清）") return dur * 9;
    return dur * 5;
  },
  async submit(input, params) {
    const { useSettingsStore } = await import("@/store/settingsStore");
    const apiKey = useSettingsStore.getState().apiKeys["jianmeng"] || "";
    if (!apiKey) {
      throw new Error("未配置简梦 API 密钥，请在设置中添加");
    }

    const model = resolveJianmengModel((params.resolution as string) || "480p");
    const aspectRatio = normalizeAR((params.aspect_ratio as string) || "16:9");
    const duration = Math.max(4, Math.min(15, num(params, "duration", 4)));

    const imageUrls = (input.imageIds as string[] | undefined) || [];
    const videoUrls = (input.videoIds as string[] | undefined) || [];
    const audioUrls = (input.audioIds as string[] | undefined) || [];

    const uploadedImages = await Promise.all(imageUrls.map(uploadToCatbox));
    const uploadedVideos = await Promise.all(videoUrls.map(uploadToCatbox));
    const uploadedAudios = await Promise.all(audioUrls.map(uploadToCatbox));

    const validImages = uploadedImages.filter(u => u.startsWith("http"));
    const validVideos = uploadedVideos.filter(u => u.startsWith("http"));
    const validAudios = uploadedAudios.filter(u => u.startsWith("http"));

    const body: Record<string, unknown> = {
      model,
      prompt: (input.text as string) || "A beautiful cinematic scene",
      duration,
      aspect_ratio: aspectRatio,
    };

    if (validImages.length > 0) body.image_url = validImages[0];
    if (validImages.length > 1) body.extra_images = validImages.slice(1);
    if (validVideos.length > 0) body.extra_videos = validVideos;
    if (validAudios.length > 0) body.extra_audios = validAudios;

    if ((body.extra_images as any[])?.length === 0) delete body.extra_images;
    if ((body.extra_videos as any[])?.length === 0) delete body.extra_videos;
    if ((body.extra_audios as any[])?.length === 0) delete body.extra_audios;

    const startMs = Date.now();
    const url = `${JIANMENG_API_BASE}/v1/videos`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    printLLMRequest(`SeedanceAdapter:${model}`, url, "POST", headers, body);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      printLLMError(`SeedanceAdapter:${model}`, durationMs, err);
      throw err;
    }

    const durationMs = Date.now() - startMs;
    if (!res.ok) {
      const errText = await res.text();
      printLLMError(`SeedanceAdapter:${model}`, durationMs, new Error(errText));
      throw new Error(`简梦 API 提交失败: ${errText}`);
    }

    const data = await res.json() as any;
    printLLMResponse(`SeedanceAdapter:${model}`, res.status, durationMs, data);

    const externalId = data.task_id || data.id;
    if (!externalId) throw new Error("API 响应缺少 task_id");

    const taskId = `seedance-${externalId}`;
    localTasks.set(taskId, {
      externalId,
      status: "queued",
      progress: 0,
    });

    console.log(`[Seedance] Task submitted: ${externalId}`);
    return { taskId };
  },
  async poll(taskId: string) {
    const { useSettingsStore } = await import("@/store/settingsStore");
    const apiKey = useSettingsStore.getState().apiKeys["jianmeng"] || "";

    const local = localTasks.get(taskId);
    if (!local) return { status: "failed", progress: 0, error: "任务未找到" } as PollResult;

    const startPollMs = Date.now();
    const url = `${JIANMENG_API_BASE}/v1/videos/${local.externalId}`;
    const headers = { "Authorization": `Bearer ${apiKey}` };

    try {
      printLLMRequest(`SeedanceAdapterPoll`, url, "GET", headers, null);

      const res = await fetch(url, {
        headers,
      });

      const durationMs = Date.now() - startPollMs;
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        printLLMError(`SeedanceAdapterPoll`, durationMs, new Error(`HTTP ${res.status}: ${errText}`));
        throw new Error(`Poll failed: HTTP ${res.status}`);
      }

      const data = await res.json() as any;
      printLLMResponse(`SeedanceAdapterPoll`, res.status, durationMs, data);
      const status = data.status;

      if (status === "completed") {
        local.status = "success";
        local.progress = 100;
        local.resultUri = data.video_url;
        localTasks.set(taskId, local);
        console.log(`[Seedance] Task completed: ${data.video_url}`);
        return {
          status: "success",
          progress: 100,
          resultUri: data.video_url,
        };
      }

      if (status === "failed") {
        local.status = "failed";
        local.progress = 100;
        local.error = data.error || "生成失败";
        localTasks.set(taskId, local);
        return { status: "failed", progress: 100, error: local.error };
      }

      const progressMap: Record<string, number> = { queued: 10, dispatched: 20, running: 50 };
      const progress = progressMap[status] ?? 30;
      local.status = status;
      local.progress = progress;
      localTasks.set(taskId, local);
      return { status: "running" as any, progress };
    } catch (err: any) {
      const durationMs = Date.now() - startPollMs;
      printLLMError(`SeedanceAdapterPoll`, durationMs, err);
      return { status: "failed", progress: 100, error: err.message };
    }
  },
};