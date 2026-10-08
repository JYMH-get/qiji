import type { CSSProperties } from "react";
import { useEffectiveModelKey } from "./ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import { LOCAL_MODEL_LABELS } from "@/services/adapters/localChannels";
import { buildImageParams } from "@/lib/genParams";
import { imageResolutionOptionsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import "./ProjectGenerationSummary.css";

const QUALITY_LABELS: Record<string, string> = { low: "低画质", medium: "中画质", high: "高画质", auto: "自动画质" };

/** 项目默认生成设置摘要，两种编辑模式共用；单镜覆盖仍在分镜控件中显示。 */
export default function ProjectGenerationSummary({ className = "", showVideo = true, style }: {
    className?: string;
    showVideo?: boolean;
    style?: CSSProperties;
}) {
    const ms = useProjectStore(s => s.mediaSettings);
    const models = useCatalogStore(s => s.catalog?.models);
    const textKey = useEffectiveModelKey("text");
    const imageKey = useEffectiveModelKey("image");
    const videoKey = useEffectiveModelKey("video");
    const label = (key: string) => models?.find(m => m.id === key)?.label || LOCAL_MODEL_LABELS[key] || key || "未选模型";
    const req = videoReqOptionsForKey(videoKey);
    const imageResolution = String(ms.imageResolution ?? buildImageParams({}, imageResolutionOptionsForKey(imageKey)).resolution).toUpperCase();
    const quality = ms.imageQuality ?? "high";
    const asset = ms.genWithAsset ?? true;
    const story = ms.genWithStory ?? false;
    const entries = [
        { name: "文本", model: label(textKey), params: "" },
        { name: "图像", model: label(imageKey), params: `${ms.imageAspect ?? "16:9"} ${imageResolution} ${QUALITY_LABELS[quality] ?? quality}` },
        ...(showVideo ? [
            { name: "视频", model: label(videoKey), params: `${ms.aspect ?? req.aspects[0] ?? "16:9"} ${ms.resolution ?? req.resolutions[0] ?? "720p"}` },
            { name: "垫图", model: asset && story ? "资产+故事板" : asset ? "资产" : story ? "故事板" : "无", params: "" },
        ] : []),
    ];
    return <div className={`qj-generation-summary ${className}`} style={style} aria-label="当前生成设置" tabIndex={0}>
        {entries.map(entry => <span key={entry.name} className="qj-generation-summary-item" title={`${entry.name}：${entry.model} ${entry.params}`.trim()}>
            <b>{entry.model}</b>{entry.params && <span> {entry.params}</span>}
        </span>)}
    </div>;
}
