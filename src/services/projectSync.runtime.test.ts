import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { SyncMsg } from "@/lib/projectSyncCore";
const transport = vi.hoisted(() => ({send:vi.fn(),receive:undefined as undefined | ((msg:SyncMsg)=>void),peers:true}));
vi.mock("./windowSync", () => ({windowId:"local",initWindowSync:async()=>{},broadcastSync:transport.send,
    onSyncMessage:(fn:(msg:SyncMsg)=>void)=>{transport.receive=fn;},setSyncContext:vi.fn(),isProjectWriter:()=>true,
    getPeers:()=>transport.peers?[{projectPath:"test.Qiji"}]:[]}));
vi.mock("@/popout/popout",()=>({isPopout:()=>false}));
import { initProjectSync } from "./projectSync";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { cancelAllSaves } from "@/store/debouncedSave";

describe("多窗口进度只同步临时态",()=>{
    beforeAll(async()=>{initProjectSync();await Promise.resolve();});
    beforeEach(async()=>{
        vi.useFakeTimers();transport.peers=true;
        useProjectStore.setState({savePath:"test.Qiji",isProjectLoading:false,canvasEpisodeId:"a",episodes:[{id:"a",shots:[]}] as never});
        useCanvasStore.setState({nodes:{},edges:{},groups:{},runtime:{}});
        await vi.advanceTimersByTimeAsync(300); transport.send.mockClear(); cancelAllSaves();
    });
    afterEach(()=>{cancelAllSaves();vi.clearAllTimers();vi.useRealTimers();});
    it("只发送变化节点，不带整张画布",async()=>{
        useCanvasStore.getState().setRuntime("n",{progress:50});
        await vi.advanceTimersByTimeAsync(250);
        const msgs=transport.send.mock.calls.map(c=>c[0]);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toMatchObject({type:"runtime",canvasKey:"a",runtime:{n:{progress:50}}});
        expect(msgs[0]).not.toHaveProperty("nodes");
    });
    it("接收进度不替换结构、不保存、不回声",async()=>{
        const before=useCanvasStore.getState();
        const save=vi.spyOn(useProjectStore.getState(),"scheduleAutoSave");
        transport.receive!({type:"runtime",senderId:"other",projectPath:"test.Qiji",canvasKey:"a",runtime:{n:{progress:70}}});
        expect(useCanvasStore.getState().nodes).toBe(before.nodes);
        expect(useCanvasStore.getState().runtime.n.progress).toBe(70);
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(transport.send).not.toHaveBeenCalled();save.mockRestore();
    });
    it("单窗口进度不广播",async()=>{
        transport.peers=false;
        useCanvasStore.getState().setRuntime("n",{progress:80});
        await vi.advanceTimersByTimeAsync(250);
        expect(transport.send).not.toHaveBeenCalled();
    });
    it("换项目后丢弃旧进度补丁",async()=>{
        useCanvasStore.getState().setRuntime("n",{progress:80});
        useProjectStore.setState({savePath:"different.Qiji"});
        transport.send.mockClear();
        await vi.advanceTimersByTimeAsync(250);
        expect(transport.send.mock.calls.some(c=>c[0].type==="runtime")).toBe(false);
    });
});
