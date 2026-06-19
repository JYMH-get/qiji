/**
 * channelAdapter — 桥接 channels 配置与 ModelAdapter 契约。
 *
 * 当 settingsStore.channels 变化时，从每个渠道为每个模型注册一个动态 adapter。
 * adapter key = "ch-{channelId}:{modelName}"，面板侧通过此 key 选择模型。
 *
 * 节点类型映射：
 *   text / script → text 类模型（capability: chat completion）
 *   image         → image 类模型（capability: 图像生成）
 *   video         → video 类模型（capability: 视频生成）
 *   audio         → audio 类模型（capability: TTS）
 */

import type { NodeType } from "@/types";
import type { ModelAdapter, CapabilityMode, SubmitResult, PollResult } from "./types";
import { registerAdapter, getAdapter } from "./registry";
import { useSettingsStore, type Channel } from "@/store/settingsStore";
import { useProjectStore } from "@/store/projectStore";
import { printLLMRequest, printLLMResponse, printLLMError } from "./utils";

/** 节点类型 → channel 分类（用于从 defaults 读默认模型） */
const NODE_TYPE_TO_CAT: Record<string, string> = {
  text: "text",
  script: "text",
  image: "image",
  video: "video",
  audio: "audio",
};

// ── 模型能力分类（参考参考项目 use-config-store.ts 的启发式分类） ──

const IMAGE_PATTERNS = /image|imagine|img|dall|flux|sd|xing|gpt-image|midjourney|mj|stable|kolors|draw|画/;
const VIDEO_PATTERNS = /video|dance|seed|kling|wan|veo|sora|gen-3|mov|视|runway|hailuo|cogvideo|luma|pika/;
const AUDIO_PATTERNS = /tts|audio|voice|speech|music|suno|音|声/;
const TEXT_PATTERNS = /gpt|claude|gemini|qwen|deep|llama|mistral|grok|glm|yi-|doubao|step|chat|text|glm-/;

/** 推断模型名是否匹配某能力类型 */
function isImageModel(name: string): boolean {
  const n = name.toLowerCase();
  if (IMAGE_PATTERNS.test(n)) return true;
  // 排除明显是视频/音频的模型
  if (VIDEO_PATTERNS.test(n) || AUDIO_PATTERNS.test(n)) return false;
  return false;
}
function isVideoModel(name: string): boolean {
  return VIDEO_PATTERNS.test(name.toLowerCase());
}
function isAudioModel(name: string): boolean {
  return AUDIO_PATTERNS.test(name.toLowerCase());
}
function isTextModel(name: string): boolean {
  const n = name.toLowerCase();
  if (TEXT_PATTERNS.test(n)) return true;
  // 排除非文本模型
  if (IMAGE_PATTERNS.test(n) || VIDEO_PATTERNS.test(n) || AUDIO_PATTERNS.test(n)) return false;
  // 无法归类的模型默认当作通用文本模型
  return true;
}

/** 返回模型名可服务的节点类型列表 */
function classifyModelNodeTypes(modelName: string): NodeType[] {
  const types: NodeType[] = [];
  if (isImageModel(modelName)) types.push("image");
  if (isVideoModel(modelName)) types.push("video");
  if (isAudioModel(modelName)) types.push("audio");
  if (isTextModel(modelName)) types.push("text", "script");
  // 如果无法归类任何类型，作为通用文本模型
  if (types.length === 0) types.push("text", "script");
  return types;
}


/** 能力类型 → modes 定义 */
function modesForNodeType(nodeType: NodeType): CapabilityMode[] {
  if (nodeType === "text" || nodeType === "script") {
    return [
      {
        key: "chat",
        label: "文本生成",
        inputHint: "输入提示词...",
        paramsSchema: [
          { key: "temperature", label: "温度", type: "number", default: 0.7, min: 0, max: 2, step: 0.1 },
          { key: "maxTokens", label: "最大长度", type: "number", default: 2048, min: 1, max: 8192, step: 256, unit: "tokens" },
        ],
      },
    ];
  }
  if (nodeType === "image") {
    return [
      {
        key: "text-to-image",
        label: "文生图",
        inputHint: "描述你想要生成的图片...",
        paramsSchema: [
          { key: "size", label: "尺寸", type: "enum", options: ["1024x1024", "1792x1024", "1024x1792"], default: "1024x1024" },
          { key: "quality", label: "质量", type: "enum", options: ["标准", "高清"], default: "标准" },
          { key: "quantity", label: "数量", type: "number", default: 1, min: 1, max: 4, step: 1 },
        ],
      },
    ];
  }
  if (nodeType === "video") {
    return [
      {
        key: "text-to-video",
        label: "文生视频",
        inputHint: "描述你想要生成的视频...",
        paramsSchema: [
          { key: "duration", label: "时长", type: "number", default: 5, min: 4, max: 15, step: 1, unit: "s" },
          { key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p（标清）", "1080p（高清）"], default: "480p" },
          { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）"], default: "横屏（16:9）" },
        ],
      },
    ];
  }
  // audio
  return [
    {
      key: "text-to-speech",
      label: "文本转语音",
      inputHint: "输入要朗读的文本...",
      paramsSchema: [
        { key: "voiceType", label: "音色", type: "enum", options: ["男声", "女声", "童声"], default: "女声" },
        { key: "duration", label: "时长", type: "number", default: 10, min: 1, max: 60, step: 1, unit: "s" },
      ],
    },
  ];
}

/** 为一个渠道 + 模型名生成 adapter key */
function channelModelKey(channelId: string, modelName: string): string {
  return `${channelId}:${modelName}`;
}

/** 从 adapter key 解析 channelId 和 modelName */
function parseAdapterKey(key: string): { channelId: string; modelName: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return { channelId: key.slice(0, idx), modelName: key.slice(idx + 1) };
}

/** 构建一个动态 adapter */
function buildDynamicAdapter(
  channel: Channel,
  modelName: string,
  nodeTypes: NodeType[],
): ModelAdapter {
  const key = channelModelKey(channel.id, modelName);
  const modes = nodeTypes.length > 0 ? modesForNodeType(nodeTypes[0]) : [];

  return {
    key,
    displayName: modelName,
    vendor: channel.name,
    nodeTypes,
    modes,
    baseCost: 10,

    estimateCost: () => 10,

    submit: async (input, params, nodeType): Promise<SubmitResult> => {
      const { startTrace, recordRequest, recordResponse, recordError } = await import("@/services/taskBlackbox");
      const baseUrl = channel.baseUrl.replace(/\/+$/, "");
      const prompt = (input.prompt as string) || "";
      const effectiveNodeType = nodeType ?? nodeTypes[0] ?? "text";
      const startMs = Date.now();
      const taskId = `task-${Date.now()}`;

      // 黑匣子：开始追踪（用 nodeId 作为 key，方便 UI 查询）
      startTrace((input._nodeId as string) || taskId, effectiveNodeType, key, modelName);

      let url = "";
      let method = "POST";
      let body: any = {};
      let reqHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel.apiKey}`,
      };

      const settings = useSettingsStore.getState();
      const config = settings.modelRequests?.[key];

      if (config && config.requestType === "custom") {
        method = config.method || "POST";
        const configUrl = config.url || "";
        if (configUrl.startsWith("http://") || configUrl.startsWith("https://")) {
          url = configUrl;
        } else {
          url = `${baseUrl}/${configUrl.replace(/^\/+/, "")}`;
        }

        if (config.headers) {
          reqHeaders = { ...reqHeaders, ...config.headers };
        }

        let bodyText = config.bodyTemplate || "";
        const escapedPrompt = JSON.stringify(prompt).slice(1, -1);
        bodyText = bodyText.replace(/\{\{input\}\}/g, escapedPrompt);
        bodyText = bodyText.replace(/\{\{model\}\}/g, modelName);
        bodyText = bodyText.replace(/\{\{size\}\}/g, (params.size as string) ?? "1024x1024");
        bodyText = bodyText.replace(/\{\{quantity\}\}/g, String((params.quantity as number) ?? 1));
        bodyText = bodyText.replace(/\{\{n\}\}/g, String((params.quantity as number) ?? 1));
        bodyText = bodyText.replace(/\{\{duration\}\}/g, String((params.duration as number) ?? 5));
        bodyText = bodyText.replace(/\{\{aspect_ratio\}\}/g, (params.aspect_ratio as string) ?? "16:9");
        bodyText = bodyText.replace(/\{\{voice\}\}/g, (params.voiceType as string) ?? "alloy");
        bodyText = bodyText.replace(/\{\{voiceType\}\}/g, (params.voiceType as string) ?? "alloy");
        bodyText = bodyText.replace(/\{\{temperature\}\}/g, String((params.temperature as number) ?? 0.7));
        bodyText = bodyText.replace(/\{\{maxTokens\}\}/g, String((params.maxTokens as number) ?? 2048));
        bodyText = bodyText.replace(/\{\{max_tokens\}\}/g, String((params.maxTokens as number) ?? 2048));

        // Attempt parsing
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      } else {
        // ── 按节点类型路由到正确的 API 端点 ──
        if (effectiveNodeType === "image") {
          url = `${baseUrl}/v1/images/generations`;
          body = {
            model: modelName,
            prompt,
            n: (params.quantity as number) ?? 1,
            size: (params.size as string) ?? "1024x1024",
            quality: (params.quality as string) ?? "standard",
            response_format: "b64_json",
          };
        } else if (effectiveNodeType === "audio") {
          url = `${baseUrl}/v1/audio/speech`;
          body = {
            model: modelName,
            input: prompt,
            voice: (params.voiceType as string) ?? "alloy",
          };
        } else if (effectiveNodeType === "video") {
          url = `${baseUrl}/v1/videos`;
          body = {
            model: modelName,
            prompt,
            duration: (params.duration as number) ?? 5,
            aspect_ratio: (params.aspect_ratio as string) ?? "16:9",
          };
        } else {
          // text / script → chat completion
          url = `${baseUrl}/v1/chat/completions`;
          body = {
            model: modelName,
            messages: [{ role: "user", content: prompt }],
            temperature: (params.temperature as number) ?? 0.7,
            max_tokens: (params.maxTokens as number) ?? 2048,
          };
        }
      }

      // 黑匣子：记录请求
      recordRequest(taskId, {
        timestamp: new Date().toISOString(),
        url,
        method,
        headers: reqHeaders.Authorization
          ? { ...reqHeaders, Authorization: "Bearer ***" }
          : reqHeaders,
        body,
      });
      // 探针：打印请求
      printLLMRequest(`ChannelAdapter:${modelName}`, url, method, reqHeaders, body);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: reqHeaders,
          body: typeof body === "string" ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        const durationMs = Date.now() - startMs;
        recordError(taskId, err as Error);
        printLLMError(`ChannelAdapter:${modelName}`, durationMs, err);
        throw err;
      }

      // 黑匣子：记录响应
      const durationMs = Date.now() - startMs;
      const respBody = effectiveNodeType === "audio"
        ? await resp.clone().blob().then((b) => `Blob(${b.size} bytes, ${b.type})`)
        : await resp.clone().json().catch(() => resp.clone().text()).catch(() => "<unreadable>");

      recordResponse(taskId, {
        timestamp: new Date().toISOString(),
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries()),
        body: respBody,
        durationMs,
      });
      // 探针：打印响应
      printLLMResponse(`ChannelAdapter:${modelName}`, resp.status, durationMs, respBody);

      if (!resp.ok) {
        const errorText = typeof respBody === "string" ? respBody.slice(0, 300) : JSON.stringify(respBody).slice(0, 300);
        const err = new Error(`HTTP ${resp.status} ${resp.statusText}: ${errorText}`);
        recordError(taskId, err);
        throw err;
      }

      // ── 根据类型处理响应 ─
      if (effectiveNodeType === "audio") {
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        _pendingResults.set(taskId, { content: objectUrl, model: modelName });
      } else if (effectiveNodeType === "image") {
        const json = await resp.json();
        const item = json.data?.[0];
        let imageUri = "";
        if (item?.b64_json) {
          imageUri = `data:image/png;base64,${item.b64_json}`;
        } else if (item?.url) {
          imageUri = item.url;
        }
        _pendingResults.set(taskId, { content: imageUri, model: modelName });
      } else if (effectiveNodeType === "video") {
        // 视频通常是异步的，返回 task_id 需要轮询
        const json = await resp.json();
        const externalId = json.task_id || json.id || "";
        if (externalId) {
          _asyncTasks.set(taskId, { externalId, model: modelName, baseUrl, apiKey: channel.apiKey });
          return { taskId };
        }
        _pendingResults.set(taskId, { content: json.video_url || json.url || JSON.stringify(json), model: modelName });
      } else {
        // text/script — chat completion
        const json = await resp.json();
        const content = json.choices?.[0]?.message?.content ?? "";
        _pendingResults.set(taskId, { content, model: modelName });
      }

      return { taskId };
    },

    poll: async (taskId): Promise<PollResult> => {
      // 同步结果（文本/图片/音频）
      const result = _pendingResults.get(taskId);
      if (result) {
        _pendingResults.delete(taskId);
        return { status: "success", progress: 100, resultUri: result.content };
      }

      // 异步任务（视频等）— 轮询远端
      const asyncTask = _asyncTasks.get(taskId);
      if (asyncTask) {
        const startPollMs = Date.now();
        try {
          const { recordPoll } = await import("@/services/taskBlackbox");
          const pollUrl = `${asyncTask.baseUrl.replace(/\/+$/, "")}/v1/videos/${asyncTask.externalId}`;
          const headers = { Authorization: `Bearer ${asyncTask.apiKey}` };
          printLLMRequest(`ChannelAdapterPoll:${asyncTask.model}`, pollUrl, "GET", headers, null);

          const resp = await fetch(pollUrl, {
            headers,
          });

          const json = await resp.json().catch(() => ({}));
          recordPoll(taskId, json.status ?? "unknown", json.progress ?? 0, json);

          const durationMs = Date.now() - startPollMs;
          printLLMResponse(`ChannelAdapterPoll:${asyncTask.model}`, resp.status, durationMs, json);

          if (json.status === "completed" || json.status === "succeeded") {
            _asyncTasks.delete(taskId);
            return { status: "success", progress: 100, resultUri: json.video_url || json.url || "" };
          }
          if (json.status === "failed") {
            _asyncTasks.delete(taskId);
            return { status: "failed", progress: 100, error: json.error || "视频生成失败" };
          }
          return { status: "running", progress: json.progress ?? 50 };
        } catch (err) {
          const durationMs = Date.now() - startPollMs;
          printLLMError(`ChannelAdapterPoll:${asyncTask.model}`, durationMs, err);
          return { status: "failed", progress: 100, error: (err as Error).message };
        }
      }

      // 找不到任务 — 返回空成功
      return { status: "success", progress: 100, resultUri: "" };
    },
  };
}

// 同步请求的暂存
const _pendingResults = new Map<string, { content: string; model: string }>();

// 异步任务暂存（视频等需要轮询的场景）
const _asyncTasks = new Map<string, { externalId: string; model: string; baseUrl: string; apiKey: string }>();

/**
 * 根据 channels 配置同步注册/更新所有动态 adapter。
 * 在 settingsStore 初始化后 + channels 变更时调用。
 */
export function syncChannelAdapters(): void {
  const { channels } = useSettingsStore.getState();

  for (const ch of channels) {
    if (!ch.baseUrl || !ch.apiKey) continue;
    for (const modelName of ch.models) {
      const nodeTypes = classifyModelNodeTypes(modelName);
      const adapter = buildDynamicAdapter(ch, modelName, nodeTypes);
      registerAdapter(adapter);
    }
  }
}

/** 获取所有可选模型选项（面板使用） */
export interface ModelOption {
  id: string; // adapter key
  label: string; // 模型名（渠道名）
  channelName: string;
  modelName: string;
}

/** 获取所有渠道的所有模型（不过滤能力分类，用于设置 UI 下拉菜单） */
export function getAllChannelModels(): ModelOption[] {
  const { channels } = useSettingsStore.getState();
  const result: ModelOption[] = [];

  for (const ch of channels) {
    if (!ch.baseUrl || !ch.apiKey) continue;
    for (const modelName of ch.models) {
      result.push({
        id: channelModelKey(ch.id, modelName),
        label: `${modelName}（${ch.name}）`,
        channelName: ch.name,
        modelName,
      });
    }
  }

  return result;
}

/** 获取某节点类型已选中的模型（仅按 selectedModels 过滤，不做能力分类） */
export function getChannelModelsForNodeType(nodeType: NodeType): ModelOption[] {
  const { channels, selectedModels } = useSettingsStore.getState();
  const selected = new Set(selectedModels[nodeType] ?? []);
  if (selected.size === 0) return [];

  const result: ModelOption[] = [];
  for (const ch of channels) {
    if (!ch.baseUrl || !ch.apiKey) continue;
    for (const modelName of ch.models) {
      const id = channelModelKey(ch.id, modelName);
      if (!selected.has(id)) continue;
      result.push({
        id,
        label: `${modelName}（${ch.name}）`,
        channelName: ch.name,
        modelName,
      });
    }
  }
  return result;
}

/** 获取某节点类型的默认模型 adapter key */
export function getDefaultModelKey(nodeType: NodeType): string {
  const { imageDefaults, videoDefaults, textDefaults, audioDefaults } = useSettingsStore.getState();
  const cat = NODE_TYPE_TO_CAT[nodeType] ?? "text";
  const defaults = { image: imageDefaults, video: videoDefaults, text: textDefaults, audio: audioDefaults }[cat];
  return defaults?.defaultModelId ?? "";
}

export { channelModelKey, parseAdapterKey, NODE_TYPE_TO_CAT };

/** 根据设置及选中的模型参数解析真正起作用的画布节点模型 key */
export function resolveActiveModelKey(
  nodeType: NodeType,
  modelParam: unknown,
  defaultMockModel: string,
): string {
  // 1. 如果节点单独配置了具体的有效模型，使用节点的配置
  if (
    typeof modelParam === "string" && 
    modelParam !== "" && 
    modelParam !== "default" && 
    modelParam !== "auto" && 
    modelParam !== defaultMockModel
  ) {
    return modelParam;
  }

  // 2. 否则，应用画布全局默认配置 (projectModelConfig.canvasText 等)
  const cat = NODE_TYPE_TO_CAT[nodeType] ?? "text";
  const projectConfig = useProjectStore.getState().projectModelConfig || {};
  let canvasDefaultModelId = "";
  if (cat === "text") canvasDefaultModelId = projectConfig.canvasText || "";
  else if (cat === "image") canvasDefaultModelId = projectConfig.canvasImage || "";
  else if (cat === "video") canvasDefaultModelId = projectConfig.canvasVideo || "";
  else if (cat === "audio") canvasDefaultModelId = projectConfig.canvasAudio || "";

  if (
    canvasDefaultModelId && 
    canvasDefaultModelId !== "default" && 
    canvasDefaultModelId !== "auto" && 
    getAdapter(canvasDefaultModelId)
  ) {
    return canvasDefaultModelId;
  }

  // 3. 否则，应用全局默认配置 (settingsStore 中的默认模型)
  const defaultSettingKey = getDefaultModelKey(nodeType);
  if (defaultSettingKey && getAdapter(defaultSettingKey)) {
    return defaultSettingKey;
  }

  // 4. 退回默认 Mock 模型
  return defaultMockModel;
}

/** 解析资产/表格模式下真正起作用的模型 key */
export function resolveAssetModelKey(
  category: "text" | "image" | "video" | "audio",
  defaultMockModel: string,
): string {
  // 1. 优先使用项目内针对资产模式配置的模型 (projectModelConfig.tableText 等)
  const projectConfig = useProjectStore.getState().projectModelConfig || {};
  let tableDefaultModelId = "";
  if (category === "text") tableDefaultModelId = projectConfig.tableText || "";
  else if (category === "image") tableDefaultModelId = projectConfig.tableImage || "";
  else if (category === "video") tableDefaultModelId = projectConfig.tableVideo || "";
  else if (category === "audio") tableDefaultModelId = projectConfig.tableAudio || "";

  if (
    tableDefaultModelId && 
    tableDefaultModelId !== "default" && 
    tableDefaultModelId !== "auto" && 
    getAdapter(tableDefaultModelId)
  ) {
    return tableDefaultModelId;
  }

  // 2. 否则，回退到全局设置对应的默认模型 (settingsStore 中的默认模型)
  const defaultSettingKey = getDefaultModelKey(category);
  if (defaultSettingKey && getAdapter(defaultSettingKey)) {
    return defaultSettingKey;
  }

  // 3. 退回默认 Mock 模型
  return defaultMockModel;
}