import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCanvasAutoSave } from "./canvasAutoSave";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { cancelAllSaves, notifySaved } from "@/store/debouncedSave";

vi.mock("@/nodes/pluginRegistry", () => ({ resumeCanvasNodeTasks: vi.fn() }));
vi.mock("@/store/requestLedgerStore", () => ({ onProjectContextChanged: vi.fn() }));

describe("画布进度和自动保存隔离", () => {
    let stop: () => void;
    let save: ReturnType<typeof vi.fn>;
    const originalSave = useProjectStore.getState().save;
    beforeEach(() => {
        vi.useFakeTimers(); cancelAllSaves();
        save = vi.fn(async () => { notifySaved(); });
        useProjectStore.setState({ save: save as never, savePath: "test.Qiji", isProjectLoading: false,
            isDirty: false, isSaving: false, canvasEpisodeId: "a", rtcEpisodeId: "a",
            episodes: [{id:"a",shots:[]},{id:"b",shots:[]}] as never,
            uiSnapshot: {route:"/frame-canvas",video:{episodeId:"a"}}, canvases:{} });
        useCanvasStore.setState({nodes:{},edges:{},groups:{},runtime:{}});
        stop = startCanvasAutoSave();
    });
    afterEach(() => { stop(); cancelAllSaves(); useProjectStore.setState({save:originalSave,savePath:null}); vi.useRealTimers(); });

    it("100次进度更新不保存、不标脏，重复进度不通知", async () => {
        const listener = vi.fn(); const off=useCanvasStore.subscribe(listener);
        for(let progress=1;progress<=100;progress++) useCanvasStore.getState().setRuntime("n",{progress});
        const calls=listener.mock.calls.length;
        useCanvasStore.getState().setRuntime("n",{progress:100});
        expect(listener).toHaveBeenCalledTimes(calls); off();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(save).not.toHaveBeenCalled();
        expect(useProjectStore.getState().isDirty).toBe(false);
    });
    it("持续编辑按30秒保存，而非等待停止编辑", async () => {
        for(let i=0;i<6;i++) {
            useCanvasStore.getState().setViewport({x:i,y:0,zoom:1});
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(save).toHaveBeenCalledTimes(1);
    });
    it.each(["canvas","table","mode","rtc"])("%s 切换提前保存一次", async kind => {
        const ps=useProjectStore.getState();
        if(kind==="canvas") ps.switchCanvas("b");
        if(kind==="table") ps.setUiSnapshot({video:{episodeId:"b"}});
        if(kind==="mode") ps.setUiSnapshot({route:"/frame161195"});
        if(kind==="rtc") ps.switchRtcEpisode("b");
        await vi.advanceTimersByTimeAsync(0);
        expect(save).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(save).toHaveBeenCalledTimes(1);
    });
    it("加载及新项目不被后台保存", async () => {
        useProjectStore.setState({isProjectLoading:true});
        useCanvasStore.getState().setViewport({x:1,y:0,zoom:1});
        useProjectStore.setState({isProjectLoading:false,savePath:null});
        useCanvasStore.getState().setViewport({x:2,y:0,zoom:1});
        await vi.advanceTimersByTimeAsync(30_000);
        expect(save).not.toHaveBeenCalled();
    });
});
