import { describe, it, expect } from "vitest";
import { stripHeavyRefs } from "./stripHeavyRefs";
import type { GenMeta, RefImgMemo, AssetBlob } from "@/services/projectFile";

const blobs: Record<string, AssetBlob> = {
  C001: { id: "C001", url: "https://oss.example.com/C001.png" },
  C002: { id: "C002", url: "http://asset.localhost/D:/x/C002.png" }, // webview 伪域，不算公网
};

describe("stripHeavyRefs", () => {
  it("genMeta 里的 data: 垫图凭 id 换成公网 url", () => {
    const gm: Record<string, GenMeta> = {
      "img1": { prompt: "画张三", at: 1, refs: [{ id: "C001", name: "张三", uri: "data:image/png;base64,AAAA" }] },
    };
    const r = stripHeavyRefs(gm, {}, blobs);
    expect(r.stripped).toBe(1);
    expect(r.genMeta.img1.refs[0].uri).toBe("https://oss.example.com/C001.png");
    expect(r.genMeta.img1.refs[0].name).toBe("张三"); // 元信息保留
  });

  it("查不到公网 url 的 data:/blob: 丢字节、留 id/name", () => {
    const gm: Record<string, GenMeta> = {
      "img1": { prompt: "", at: 1, refs: [
        { id: "C002", name: "李四", uri: "data:image/png;base64,BBBB" }, // C002 只有伪域 url
        { name: "临时", uri: "blob:http://localhost/xyz" },              // 无 id
      ] },
    };
    const r = stripHeavyRefs(gm, {}, blobs);
    expect(r.stripped).toBe(2);
    expect(r.genMeta.img1.refs[0].uri).toBe("");
    expect(r.genMeta.img1.refs[0].name).toBe("李四");
    expect(r.genMeta.img1.refs[1].uri).toBe("");
  });

  it("非 data:/blob: 的引用原样保留", () => {
    const gm: Record<string, GenMeta> = {
      "img1": { prompt: "", at: 1, refs: [{ id: "C001", uri: "https://oss.example.com/ref.png" }] },
    };
    const r = stripHeavyRefs(gm, {}, blobs);
    expect(r.stripped).toBe(0);
    expect(r.genMeta.img1.refs[0].uri).toBe("https://oss.example.com/ref.png");
  });

  it("assetRefImages：data: uri 换公网、data: url 一并解析", () => {
    const ari: Record<string, RefImgMemo[]> = {
      "char:C001:base": [{ id: "C001", name: "张三", uri: "data:image/png;base64,CCCC", url: "data:image/png;base64,CCCC" }],
    };
    const r = stripHeavyRefs({}, ari, blobs);
    expect(r.stripped).toBe(1);
    const m = r.assetRefImages["char:C001:base"][0];
    expect(m.uri).toBe("https://oss.example.com/C001.png");
    expect(m.url).toBe("https://oss.example.com/C001.png");
  });

  it("纯函数：不改传入对象", () => {
    const gm: Record<string, GenMeta> = {
      "img1": { prompt: "", at: 1, refs: [{ id: "C001", uri: "data:image/png;base64,DDDD" }] },
    };
    stripHeavyRefs(gm, {}, blobs);
    expect(gm.img1.refs[0].uri).toBe("data:image/png;base64,DDDD"); // 原对象不变
  });

  it("空输入安全", () => {
    const r = stripHeavyRefs(undefined, undefined, undefined);
    expect(r.stripped).toBe(0);
    expect(r.genMeta).toEqual({});
    expect(r.assetRefImages).toEqual({});
  });
});
