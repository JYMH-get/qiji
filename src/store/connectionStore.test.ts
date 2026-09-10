import { afterEach, describe, expect, it } from "vitest";
import { getAssetVideoFeature, getModeFeatures, useConnectionStore } from "./connectionStore";

afterEach(() => useConnectionStore.getState().setSession(false));

describe("表格入口与视频权限", () => {
    it("关闭资产视频后仍能进入表格，画布与实时剪辑保留各自开关", () => {
        useConnectionStore.getState().setSession(true, {
            id: "user", name: "用户", credits: 123,
            features: { assetMode: false, canvasMode: true, editorMode: false },
        });
        expect(getModeFeatures()).toEqual({ assetMode: true, canvasMode: true, editorMode: false });
        expect(getAssetVideoFeature()).toBe(false);
    });

    it("全部开关关闭仍能用表格生图，视频权限不会被保底逻辑重新打开", () => {
        useConnectionStore.getState().setSession(true, {
            id: "user", name: "用户", credits: 123,
            features: { assetMode: false, canvasMode: false, editorMode: false },
        });
        expect(getModeFeatures()).toEqual({ assetMode: true, canvasMode: false, editorMode: false });
        expect(getAssetVideoFeature()).toBe(false);
    });

    it("旧服务端缺省字段兼容开放，心跳重新启用后视频权限恢复", () => {
        const user = { id: "user", name: "用户", credits: 123 };
        useConnectionStore.getState().setSession(true, user);
        expect(getAssetVideoFeature()).toBe(true);
        useConnectionStore.getState().setSession(true, { ...user, features: { assetMode: false } });
        expect(getAssetVideoFeature()).toBe(false);
        useConnectionStore.getState().setSession(true, { ...user, features: { assetMode: true } });
        expect(getAssetVideoFeature()).toBe(true);
        expect(useConnectionStore.getState().user?.credits).toBe(123);
    });
});
