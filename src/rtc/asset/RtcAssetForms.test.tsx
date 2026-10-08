import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    project: {} as Record<string, any>, forms: {} as Record<string, string | null>, select: vi.fn(), open: vi.fn(),
    slots: [] as any[], cursor: 0, cleanups: [] as (() => void)[], confirm: vi.fn(), add: vi.fn(), remove: vi.fn(), save: vi.fn(), setTab: vi.fn(), setPropsTab: vi.fn(),
}));
vi.mock("react", async original => ({ ...await original<any>(),
    useState: (initial:any) => { const slots=h.slots,i=h.cursor++;if (!(i in slots)) slots[i]=initial;return [slots[i],(next:any)=>{slots[i]=typeof next==='function'?next(slots[i]):next;}]; },
    useRef: (initial:any) => { const i=h.cursor++;return h.slots[i]??(h.slots[i]={current:initial}); },
    useEffect: (effect:()=>void|(()=>void)) => {const i=h.cursor++;if (!(i in h.slots)){h.slots[i]=true;const cleanup=effect();if(cleanup)h.cleanups.push(cleanup);}},
}));
vi.mock("react-dom",()=>({createPortal:(child:ReactNode)=>child}));
vi.mock("@/lib/confirmDialog",()=>({confirmDialog:h.confirm}));
vi.mock("../panel/rtcCenterTabStore",()=>({useRtcCenterTabStore:{getState:()=>({setTab:h.setTab})}}));
vi.mock("../panel/rtcPropsTabStore",()=>({useRtcPropsTabStore:{getState:()=>({setTab:h.setPropsTab})}}));
vi.mock("./RtcAssetNameDialog",()=>({RtcAssetNameDialog:()=>null}));
vi.mock("@/store/projectStore", () => ({
    useProjectStore: Object.assign((select: any) => select(h.project), { getState: () => h.project, subscribe: vi.fn() }),
}));
vi.mock("@/store/assetFormStore", () => ({
    useAssetFormStore: Object.assign((select: any) => select({ selForm: h.forms }), {
        getState: () => ({ selForm: h.forms, setSelForm: h.select }),
    }),
}));
vi.mock("@/components/AssetDisplayImage", () => ({
    AssetDisplayImage: ({ uri, alt }: { uri: string; alt: string }) => <img src={uri} alt={alt} />,
}));
vi.mock("@/hooks/useScopedLightboxGallery", () => ({ useScopedLightboxGallery: () => h.open }));

import { RtcAssetForms } from "./RtcAssetForms";

beforeEach(() => {
    vi.clearAllMocks();h.slots=[];h.cursor=0;h.cleanups=[];
    h.select.mockReset();h.select.mockImplementation((id:string,variant:string|null)=>{h.forms[id]=variant;});
    h.open.mockReset();
    h.confirm.mockReset();h.confirm.mockResolvedValue(true);
    h.forms = {};
    h.project = { projectInstanceId: "forms-project", isProjectLoading: false, characters: [
        { id: "character-a", name: "角色甲", prompt:"基础提示词", variants: [
            { id: "ready", label: "已出图造型", image: "mem://ready" },
            { id: "pending", label: "未出图造型" },
        ] },
        { id: "character-b", name: "角色乙", image: "mem://base-b", variants: [{ id: "other", label: "另一角色造型", image: "mem://other" }] },
    ], pendingGens:[{cat:'characters',assetId:'character-a',variantId:'pending',id:'job-a'},{cat:'characters',assetId:'character-b',variantId:'other',id:'job-b'}], addAssetVariant:h.add,removeAssetVariant:h.remove,save:h.save };
    h.add.mockImplementation((cat:string,id:string,variant:any)=>{const asset=h.project[cat].find((a:any)=>a.id===id);asset.variants=[...asset.variants,variant];});
    h.remove.mockImplementation((cat:string,id:string,variant:string)=>{const asset=h.project[cat].find((a:any)=>a.id===id);asset.variants=asset.variants.filter((v:any)=>v.id!==variant);h.project.pendingGens=h.project.pendingGens.filter((p:any)=>!(p.cat===cat&&p.assetId===id&&p.variantId===variant));});
    h.save.mockResolvedValue(undefined);
    vi.stubGlobal('window',{innerWidth:1280,innerHeight:800});vi.stubGlobal('document',{body:{}});
});
afterEach(()=>{h.cleanups.forEach(cleanup=>cleanup());vi.unstubAllGlobals();});

function buttons(node: ReactNode): ReactElement<any>[] {
    if (!isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [...(element.type === "button" ? [element] : []), ...Children.toArray(element.props.children).flatMap(buttons)];
}
const tree = (id = "character-a") => {h.cursor=0;return RtcAssetForms({ cat: "characters", id });};
const markup = (id = "character-a") => {h.cursor=0;return renderToStaticMarkup(<RtcAssetForms cat="characters" id={id} />);};
function all(node:ReactNode):ReactElement<any>[] { if (!isValidElement(node))return [];const element=node as ReactElement<any>;return [element,...Children.toArray(element.props.children).flatMap(all)]; }
const dialog = () => all(tree()).find(node=>typeof node.props.onSubmit==='function')!;
const context = (label:string) => {
    buttons(tree()).find(button=>button.props.title?.startsWith(label))!.props.onContextMenu({preventDefault(){},stopPropagation(){},clientX:300,clientY:200});
    return buttons(tree()).find(button=>button.props.role==='menuitem')!;
};
const tick = async()=>{await Promise.resolve();await Promise.resolve();};
const activeButtons = (id = "character-a") => buttons(tree(id)).filter(button => button.props["aria-pressed"]);

describe("中央预览左侧分体栏", () => {
    it("基础和全部造型均显示，无图时仍提供选择入口", () => {
        const html = markup();
        expect(html).toContain('aria-label="分体选择"');
        expect(html).toContain("分体选择（3）");
        for (const label of ["基础形象", "已出图造型", "未出图造型"]) expect(html).toContain(label);
        expect(buttons(tree())).toHaveLength(4);
        expect(buttons(tree())[3].props['aria-label']).toBe('新增分体');
        expect(html).toContain('src="mem://ready"');
        expect(html).not.toContain('src=""');
    });

    it("未出图造型可选中，基础形象同时取消高亮", () => {
        h.forms["character-a"] = "pending";
        const active = activeButtons();
        expect(active).toHaveLength(1);
        expect(active[0].props.title).toContain("未出图造型");
        expect(active[0].props.title).toContain("未出图");
    });

    it.each([undefined, null, "deleted", "other"])("选择 %s 无效或未设置时只高亮当前资产基础形象", selection => {
        if (selection !== undefined) h.forms["character-a"] = selection;
        h.forms["character-b"] = "other";
        const active = activeButtons();
        expect(active).toHaveLength(1);
        expect(active[0].props.title).toContain("基础形象");
        const html = markup();
        expect(html).not.toContain("另一角色造型");
        expect(html).not.toContain("mem://other");
    });

    it("点击未出图造型与基础形象写入同一个共享选择状态", () => {
        const all = buttons(tree());
        all.find(button => button.props.title.startsWith("未出图造型"))!.props.onClick();
        all.find(button => button.props.title.startsWith("基础形象"))!.props.onClick();
        expect(h.select.mock.calls).toEqual([["character-a", "pending"], ["character-a", null]]);
    });

    it("切换到另一资产后列表和高亮只来自新目标", () => {
        h.forms["character-a"] = "pending";
        h.forms["character-b"] = "other";
        const html = markup('character-b');
        expect(html).toContain("另一角色造型");
        expect(html).not.toContain("未出图造型");
        expect(activeButtons("character-b")[0].props.title).toContain("另一角色造型");
    });

    it("已删除资产不借用另一资产的基础图和造型", () => {
        expect(markup('removed')).toBe("");
    });

    it.each(["project", "loading", "deleted-asset"])("旧列表回调在 %s 后不回写选择", change => {
        const pending = buttons(tree()).find(button => button.props.title.startsWith("未出图造型"))!;
        if (change === "project") h.project.projectInstanceId = "next-project";
        if (change === "loading") h.project.isProjectLoading = true;
        if (change === "deleted-asset") h.project.characters = h.project.characters.filter((asset: any) => asset.id !== "character-a");
        pending.props.onClick();
        expect(h.select).not.toHaveBeenCalled();
    });

    it('末尾加号打开名称弹层，新增空图分体并选中，重复提交只新增一次',()=>{
        buttons(tree()).find(button=>button.props['aria-label']==='新增分体')!.props.onClick();
        const modal=dialog();expect(modal.props.title).toBe('新增分体');
        modal.props.onSubmit('   ');expect(h.add).not.toHaveBeenCalled();
        modal.props.onSubmit('  战斗造型  ');modal.props.onSubmit('重复提交');
        expect(h.add).toHaveBeenCalledOnce();
        const [cat,id,variant]=h.add.mock.calls[0];
        expect([cat,id]).toEqual(['characters','character-a']);
        expect(variant).toMatchObject({label:'战斗造型',name:'角色甲',prompt:'基础提示词',images:[]});
        expect(variant.image).toBeUndefined();expect(variant.id).toBeTruthy();
        expect(h.select).toHaveBeenCalledWith('character-a',variant.id);expect(h.setTab).toHaveBeenCalledWith('preview');expect(h.save).toHaveBeenCalledWith(true);
        expect(h.setPropsTab).toHaveBeenCalledWith('props');
    });

    it.each(['cancel','project','loading','deleted-asset','target-change','unmount'])('新增弹层在%s后不落笔或改变当前选择',change=>{
        buttons(tree()).find(button=>button.props['aria-label']==='新增分体')!.props.onClick();const modal=dialog();
        if(change==='cancel')modal.props.onClose();
        if(change==='project')h.project.projectInstanceId='other-project';
        if(change==='loading')h.project.isProjectLoading=true;
        if(change==='deleted-asset')h.project.characters=h.project.characters.filter((asset:any)=>asset.id!=='character-a');
        if(change==='target-change')tree('character-b');
        if(change==='unmount')h.cleanups.forEach(cleanup=>cleanup());
        modal.props.onSubmit('迟到名称');expect(h.add).not.toHaveBeenCalled();expect(h.select).not.toHaveBeenCalled();
    });

    it('右击分体并确认删除清理该分体，选中回到基础，其他资产保持',async()=>{
        context('未出图造型').props.onClick();await tick();
        expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining('未出图造型'));
        expect(h.remove).toHaveBeenCalledWith('characters','character-a','pending');
        expect(h.project.characters[0].variants.map((variant:any)=>variant.id)).toEqual(['ready']);
        expect(h.project.pendingGens.map((job:any)=>job.id)).toEqual(['job-b']);
        expect(h.forms['character-a']).toBeNull();expect(h.project.characters[1].variants).toHaveLength(1);
    });

    it('基础形象右键不可删除，取消分体确认保留原内容',async()=>{
        const base=context('基础形象');expect(base.props.disabled).toBe(true);base.props.onClick();await tick();
        expect(h.confirm).not.toHaveBeenCalled();expect(h.remove).not.toHaveBeenCalled();
        h.confirm.mockResolvedValue(false);context('已出图造型').props.onClick();await tick();expect(h.remove).not.toHaveBeenCalled();
    });

    it.each(['project','loading','deleted-asset','deleted-form','target-change','unmount'])('删除确认期间%s使旧回调失效',async change=>{
        let resolve!:(value:boolean)=>void;h.confirm.mockReturnValue(new Promise<boolean>(done=>{resolve=done;}));
        context('未出图造型').props.onClick();h.select.mockClear();
        if(change==='project')h.project.projectInstanceId='other-project';
        if(change==='loading')h.project.isProjectLoading=true;
        if(change==='deleted-asset')h.project.characters=h.project.characters.filter((asset:any)=>asset.id!=='character-a');
        if(change==='deleted-form')h.project.characters[0].variants=h.project.characters[0].variants.filter((variant:any)=>variant.id!=='pending');
        if(change==='target-change')tree('character-b');
        if(change==='unmount')h.cleanups.forEach(cleanup=>cleanup());
        resolve(true);await tick();expect(h.remove).not.toHaveBeenCalled();expect(h.select).not.toHaveBeenCalled();
    });

    it('确认期间另选造型，删除原目标但不抢回新选中项',async()=>{
        let resolve!:(value:boolean)=>void;h.confirm.mockReturnValue(new Promise<boolean>(done=>{resolve=done;}));
        context('未出图造型').props.onClick();h.forms['character-a']='ready';h.select.mockClear();
        resolve(true);await tick();expect(h.remove).toHaveBeenCalledWith('characters','character-a','pending');expect(h.select).not.toHaveBeenCalled();expect(h.forms['character-a']).toBe('ready');
    });
});
