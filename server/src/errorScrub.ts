/**
 * 错误文案「渠道信息擦除」一把尺（第168轮）。
 *
 * 背景：各翻译器的报错带上游品牌前缀（「Dimensio 提交失败」等），错误文本会
 * 落盘（任务/日志）并下发给 客户端 与 渠道商门户 ——用户在管理端把模式改名后
 * （如 Dimensio→高速），这些前缀就成了渠道泄漏面。
 *
 * 规则（⚠ 勿回退）：
 *  - 任何「保存/回传」的错误文案必须经 scrubChannelInfo 过一遍——收口点在
 *    tasks.failTask / tasks.createCompletedTask / logs.applyFinishMeta / routes 同步失败响应，
 *    翻译器内部不必逐个改文案（新接渠道照旧写品牌前缀，出口统一擦）。
 *  - 「模式名」是用户可见的对外品牌（客户端下拉就显示它）——凡与**当前**模式名
 *    相同的词经占位符保护不擦（如模式仍叫「星辰」时保留），模式改名后旧品牌词自动开始被擦。
 *  - 请求日志的 ③④ 上游报文段不经此处（仅源站管理端可见，保留全量供排障）。
 */
import { listChannels } from "./store/channels.ts";
import { listModes } from "./store/modes.ts";

/** 内置翻译器错误前缀/上游品牌词（静态兜底；渠道显示名另行动态并入） */
const BRAND_TOKENS = [
	"火山 MediaKit",
	"火山引擎",
	"AIStartLab",
	"AI-Studio",
	"ZhengAPI",
	"MuseAI",
	"Dimensio",
	"Aivide",
	"星辰",
	"画影",
	"苏打水",
	"云雾",
	"火山",
	// 简梦X 系=渠道别名（渠道显示名/翻译器前缀都用它；模式已改名后即不再是对外名）。
	// ⚠ 与当前模式名相同的词经「占位符保护」自动豁免——模式仍叫「简梦S」时不误伤。
	"简梦GF",
	"简梦JA",
	"简梦P",
	"简梦M",
	"简梦Z",
	"简梦H",
	"简梦T",
	"简梦F",
	"简梦S",
	"简梦",
	// 出海营（第186轮）：翻译器前缀「出海营」；模式对外名默认 "overseas"（占位符保护，改名后即开始被擦）
	"出海营",
	"overseas",
	// 算力（第217轮，xienlive.com）：翻译器前缀「算力」=模式对外名（占位符保护，改名后即开始被擦）；站方品牌 OctopusAI
	"OctopusAI",
	"算力",
	// Yali（第229轮，api.yaliai.com）：翻译器前缀「Yali」=模式对外名（占位符保护，改名后即开始被擦）；
	// 站方全名 Yali AI Studio。「Banana / Gemini」是其接口类型名（403 文案里会出现）——属通用模型名不擦。
	"Yali AI Studio",
	"YALI",
	"Yali",
	"yaliai",
	// Skylee（第230轮，api.808relay.com）：翻译器前缀「Skylee」=模式对外名（占位符保护，改名后即开始被擦）；
	// 站点自称 Skylee API，域名段 808relay 也作品牌词擦除
	"Skylee",
	"808relay",
	// congge（第233轮，congchen.top）：翻译器前缀「congge」=模式对外名（占位符保护，改名后即开始被擦）；
	// 站方中文名「聪宸」与域名段 congchen 作品牌词擦除
	"聪宸",
	"congchen",
	// autodl（第234轮，autodl.art）：翻译器前缀「autodl」=模式对外名（占位符保护，改名后即开始被擦）；
	// ComfyUI 是其平台技术名（工作流报错可能透出）——一并作品牌词擦除
	"autodl",
	"ComfyUI",
	// 奇迹云（第249轮，自建 autodl 实例池）：翻译器前缀「奇迹云」=模式对外名（占位符保护，改名后即开始被擦）
	"奇迹云",
	// BYS（第252轮，www.boyesir.icu）：翻译器前缀「BYS」=模式对外名（占位符保护，改名后即开始被擦）；
	// 站点自称 Boyesir AI，域名段 boyesir 作品牌词擦除
	"Boyesir",
	"boyesir",
	// QiQi（第255轮，pidoi.com）：翻译器前缀「QiQi」=模式对外名（占位符保护，改名后即开始被擦）；
	// 域名段 pidoi 作品牌词擦除（⚠ 与我方品牌 Qiji 字面不同，不会误伤）
	"QiQi",
	"pidoi",
	// 官方（kwjm.com，2026-09-03）：模式名「官方」由动态模式占位符保护；协议段和域名需静态擦除。
	"official-video",
	"kwjm",
	// 协议 id 里的品牌段（「协议不存在或已禁用：dimensio-video」一类）
	"dimensio",
	"huaying",
	"aistars",
	"sudashui",
	"aivide",
	"musem",
	"suanli",
	"jianmengp",
	"jianmeng",
];

/** 已知上游域（含成片 CDN）；出现在错误文案里一律隐藏（子域一并吞掉） */
const HOST_TOKENS = [
	"dimensio.cn",
	"aixyzz.com",
	"aistarslab.com",
	"sticki.cn",
	"aivideo.beauty",
	"sudashuiapi.com",
	"museai.vip",
	"zhengapi.top",
	"chre3.com",
	"vosle.xyz",
	"pixellelabs.com", // 简梦P（api.pixellelabs.com）API 域（第242轮 2026-08 新版文档明给；成片下载端点同域）
	"zexitongxue.com",
	"jian1.vip",
	"volces.com",
	"capcut.com",
	"g-aisc.com",
	"yunwu.ai",
	"tripcdn.com",
	"jianying.com",
	"aiid.edu.kg", // 出海营（api.aiid.edu.kg）API 域
	"zhongzhuan.chat", // 出海营素材/成片代理域（文档示例 imageproxy.zhongzhuan.chat）
	"xienlive.com", // 算力（OctopusAI）API 域（第217轮）
	"vlabvod.com", // 算力成片 CDN（query 示例 v6-artist.vlabvod.com 签名时效直链）
	"yaliai.com", // Yali AI Studio API 域（第229轮；结果图直链 /v1/generated-images/ 同域）
	"808relay.com", // Skylee API 域（第230轮；主入口 api. / 备用入口 api2. 同域，子域一并吞）
	"congchen.top", // congge（聪宸）API 域（第233轮；图片结果图与视频成片若返回本站直链同域）
	"autodl.art", // autodl API 域（第234轮；成片 results[].url 若为本站直链同域）
	// 奇迹云（第249轮）：实例服务域——ComfyUI 入口（service_6006_domain）落在这几个域下，
	// 错误文案若透出实例地址一律隐藏（实例地址=渠道信息）
	"autodl.com",
	"gpuhub.com",
	"seetacloud.com",
	"boyesir.icu", // BYS（www.boyesir.icu）API 域（第252轮；成片直链与网页版 canvas. 子域一并吞）
	"pidoi.com", // QiQi（pidoi.com）API 域（第255轮；成片直链 /video/task_xxx.mp4 与下载端点同域）
	"kwjm.com", // 官方（kwjm.com）API 域；成片若同域返回也不得泄漏
];

function escRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostOf(url: string | undefined): string {
	if (!url) return "";
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/** 占位符：NUL 包裹序号（正常文案不含 NUL，绝不与正文冲突；不用转义字面量防编辑工具吞字节） */
const NUL = String.fromCharCode(0);
const PH = (i: number): string => NUL + i + NUL;

/** 把错误/提示文案里的渠道识别信息（品牌名/渠道显示名/上游域名/链接）替换为中性词 */
export function scrubChannelInfo(msg: string): string {
	if (!msg) return msg;
	let out = msg;

	// 1) 完整链接一律隐藏（上游透传的 fail_reason 可能内嵌成片/接口地址）
	out = out.replace(/https?:\/\/[^\s"'）)】,，。；;]+/g, "（链接已隐藏）");

	// 2) 域名（静态清单 + 渠道 baseUrl 的 host），连同子域前缀一起吞。
	//    ⚠ 必须在下方「模式名占位符保护」**之前**（第234轮）：autodl 模式名是其域名 autodl.art 的
	//    子串——先打占位符会把裸域名拆成 files.␀N␀.art 逃过隐藏；域名正则须整段命中 host，
	//    独立出现的模式名词永远不会被它误吞，先跑域名严格安全。
	const hosts = new Set<string>(HOST_TOKENS);
	for (const ch of listChannels()) {
		const h = hostOf(ch.baseUrl);
		if (h) hosts.add(h);
	}
	for (const h of [...hosts].sort((a, b) => b.length - a.length)) {
		out = out.replace(new RegExp(`[A-Za-z0-9.-]*${escRe(h)}`, "gi"), "（已隐藏）");
	}

	// 3) 「当前模式名」占位符保护——模式名是用户可见的对外品牌（客户端下拉就显示它），
	//    绝不擦；用占位符而非逐词豁免，防较短品牌词击中长模式名内部（「简梦」误伤「简梦S」）。
	const modeNames = [...new Set(listModes().map((m) => (m.name || "").trim()).filter((n) => n.length >= 2))]
		.sort((a, b) => b.length - a.length);
	const stash: string[] = [];
	for (const n of modeNames) {
		if (!out.includes(n)) continue;
		out = out.split(n).join(PH(stash.length));
		stash.push(n);
	}

	// 4) 品牌词（静态清单 + 渠道显示名）→ 中性词「渠道」
	const tokens = new Set<string>(BRAND_TOKENS);
	for (const ch of listChannels()) {
		const name = (ch.name || "").trim();
		if (name.length >= 2) tokens.add(name);
	}
	for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
		out = out.replace(new RegExp(escRe(t), "gi"), "渠道");
	}

	// 5) 还原被保护的模式名
	stash.forEach((n, i) => { out = out.split(PH(i)).join(n); });
	return out;
}
