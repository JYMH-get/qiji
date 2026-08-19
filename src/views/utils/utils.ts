import { useProjectStore } from "@/store/projectStore";
import { pathGuidMap } from "@/router/routes";

export const withStopPropagation = (handler?: (e: any) => void) => {
  return (e: any) => {
    e.stopPropagation();
    if (handler) {
      handler(e);
    }
  };
};

/**
 * 读取已加载项目的快照路由：校验为已知工作页才用，否则回退剧本页（旧项目/无快照兼容）。
 * 进入/导入项目后的跳转统一走它（Frame21 大厅与 Frame164 新建页共用）。
 */
export function restoreRouteAfterLoad(): string {
  const r = useProjectStore.getState().uiSnapshot?.route;
  if (r && r !== "/" && r !== "/frame164" && pathGuidMap.has(r)) return r;
  return "/frame1693";
}
