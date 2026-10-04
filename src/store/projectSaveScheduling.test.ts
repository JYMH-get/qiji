import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const commit = vi.hoisted(()=>({create:vi.fn()}));
vi.mock("./commitStore",()=>({useCommitStore:{getState:()=>({createCommit:commit.create,commits:{},head:"head"})}}));
import { useProjectStore } from "./projectStore";
import { cancelAllSaves, scheduleSave } from "./debouncedSave";

describe("保存进行中的编辑和切换",()=>{
    const blobs:Blob[]=[];
    beforeEach(()=>{
        vi.useFakeTimers();cancelAllSaves();blobs.length=0;
        commit.create.mockReset().mockResolvedValue("head");
        vi.stubGlobal("document",{createElement:()=>({click:vi.fn()})});
        vi.spyOn(URL,"createObjectURL").mockImplementation(blob=>{blobs.push(blob as Blob);return "blob:test";});
        vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
        useProjectStore.setState({savePath:"test.Qiji",isSaving:false,isProjectLoading:false,isDirty:true,name:"before"});
    });
    afterEach(()=>{cancelAllSaves();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
    it("保存途中又请求保存，完成后补存最新内容",async()=>{
        let release!: (id:string)=>void;
        commit.create.mockImplementationOnce(()=>new Promise<string>(r=>{release=r;}));
        const saving=useProjectStore.getState().save();
        await vi.waitFor(() => expect(commit.create).toHaveBeenCalled());
        useProjectStore.setState({name:"after"});scheduleSave();
        const queued = useProjectStore.getState().save();
        release("head");await saving;
        await queued;
        expect(blobs).toHaveLength(2);
        expect(JSON.parse(await blobs[0].text()).name).toBe("before");
        expect(JSON.parse(await blobs[1].text()).name).toBe("after");
        expect(useProjectStore.getState().isDirty).toBe(false);
    });
    it("保存期间的新编辑保留脏标记，30秒后保存",async()=>{
        let release!: (id:string)=>void;
        commit.create.mockImplementationOnce(()=>new Promise<string>(r=>{release=r;}));
        const saving=useProjectStore.getState().save();
        await vi.waitFor(() => expect(commit.create).toHaveBeenCalled());
        useProjectStore.setState({name:"after"});scheduleSave();
        release("head");await saving;
        expect(useProjectStore.getState().isDirty).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(blobs).toHaveLength(2);
        expect(JSON.parse(await blobs[1].text()).name).toBe("after");
    });
    it("保存失败保留待保存窗口并重试",async()=>{
        vi.spyOn(console,"error").mockImplementation(()=>{});
        commit.create.mockRejectedValueOnce(new Error("write failed"));
        await useProjectStore.getState().save();
        expect(useProjectStore.getState().isDirty).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(blobs).toHaveLength(1);
        expect(useProjectStore.getState().isDirty).toBe(false);
    });
    it("并发保存的调用者等到最后一次合并保存完成才返回", async () => {
        let release!: (id: string) => void;
        commit.create.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
        const first = useProjectStore.getState().save();
        await vi.waitFor(() => expect(commit.create).toHaveBeenCalled());
        let finished = false;
        const second = useProjectStore.getState().save(true).then(() => { finished = true; });
        await Promise.resolve(); await Promise.resolve();
        expect(finished).toBe(false);
        release("head");
        await Promise.all([first, second]);
        expect(blobs).toHaveLength(2);
        expect(finished).toBe(true);
    });
});
