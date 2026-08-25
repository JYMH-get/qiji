/**
 * templateAspect —— 从提示词模板**名称**识别内嵌比例标记（第243轮）。
 *
 * 规则（用户定稿）：项目有一个默认「影片比例」（新建项目时确定，存 mediaSettings.imageAspect/aspect）；
 * 但部分提示词模板按特定比例编写、名称里带比例标记（如「资产拆分9:16」「同源推理 16:9」）——
 * 选用这类模板时，**该步骤**优先按模板名内嵌的比例，其余步骤仍按项目默认比例；
 * 各界面单独改动仍然最高优先（本模块只提供解析与决定链，不做任何隐藏覆盖）。
 *
 * 只认应用支持的三档（16:9 / 9:16 / 1:1，与 IMAGE_ASPECTS / VIDEO_ASPECTS / SIZE_MAP 一把尺）；
 * 全角冒号「：」按半角处理；「1:10」「21:9」这类对不上已知档的数字对 → null（不误吞、不夹改）。
 */

const KNOWN_ASPECTS = new Set(["16:9", "9:16", "1:1"]);

/** 模板名 → 内嵌比例（"16:9" | "9:16" | "1:1"）；无标记/不支持的比例 → null */
export function aspectFromName(name?: string | null): string | null {
    if (!name) return null;
    for (const m of name.matchAll(/(\d{1,2})\s*[:：]\s*(\d{1,2})/g)) {
        const a = `${Number(m[1])}:${Number(m[2])}`;
        if (KNOWN_ASPECTS.has(a)) return a;
    }
    return null;
}

/**
 * 资产出图生效比例的决定链（AssetWorkbench 初始值 / RTC 资产出图共用一把尺）：
 * 资产拆分模板（选中款；空=默认款 isDefault ?? 第一款）名内嵌比例 > 项目默认 imageAspect > "16:9"。
 * templates 传 catalog.templates 原样（内部按 script.analyze 且非「内部」分类过滤，与 Frame1693 同口径）。
 */
export function assetImageAspectFrom(
    templates: { id: string; name: string; purpose?: string; category?: string; isDefault?: boolean }[] | undefined,
    chosenId: string | undefined,
    defaultAspect: string | undefined,
): string {
    const list = (templates ?? []).filter((t) => t.purpose === "script.analyze" && t.category !== "内部");
    const tpl = (chosenId ? list.find((t) => t.id === chosenId) : undefined) ?? list.find((t) => t.isDefault) ?? list[0];
    return aspectFromName(tpl?.name) ?? defaultAspect ?? "16:9";
}
