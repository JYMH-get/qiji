# Qiji 独立官网

`template/index.html` 和 `template/assets/` 保存官网模板与内置图片。构建结果是普通静态文件，可部署在独立的 Nginx、1Panel 静态网站或静态托管中；官网访问不需要运行业务服务端。

## 本地构建

使用 Node.js 24 或更新版本，并先安装项目根目录依赖：

```powershell
node scripts/build-website.mjs --config "D:\发布配置\site.json"
node scripts/build-website.mjs --config "D:\发布配置\site.json" --out "D:\发布包\qiji-website-20261007"
```

必须显式提供配置路径。配置结构与业务后台「网页管理」保存的 `site.json` 一致；构建器只读该文件，将公开字段嵌入 HTML，不加载业务 store、不连接数据库、不修改原配置、不抓取远程资源。私有字段不会被自动复制进产物，但填写在公告、联系方式等公开字段内的内容会公开展示。

输出包含：

- `public/index.html`、`public/site-assets/`：将 `public` 内的内容上传至官网的站点根目录。
- `qiji-website.zip`：解压后同样直接得到 `index.html` 与 `site-assets/`，可用于后台上传部署。

默认每次在 `outputs/website-<时间>-<随机标识>/` 建立新目录。显式指定的输出目录必须不存在；即使旧目录为空，也不会覆盖。禁止输出到 `server/data` 内。

安装包下载与管理员配置的图片继续使用配置中的公开 HTTP/HTTPS 地址。构建不会把安装包、业务数据库、`.env` 或原始 `site.json` 放入发布包，也不会替用户下载外链图片。已填写备案号会链接到工信部查询网站；未填写则隐藏。站点开关关闭时生成维护页，已填写的备案号仍会显示。修改后台内容后需要重新导出并部署官网，业务服务重启不会改变已部署的静态文件。

## 服务端集成 API

`render.ts` 仅依赖 Node.js 内置模块，导入时没有读写文件、网络或数据库副作用。调用时仅读取固定模板和 11 个内置图片。

```ts
import {
  buildWebsiteFiles,
  renderWebsitePreview,
  builtinWebsiteImages,
  type WebsiteConfig,
} from "../website/render.ts";

// WebsiteConfig 与 publicSiteConfig() 返回值结构兼容，也接受 SiteConfig。
// 原始 announcements 中 enabled:false 的项会过滤；其余未知字段不会导出。
const files = await buildWebsiteFiles(config as WebsiteConfig);
// Promise<Array<{ path: string; data: Buffer }>>
// path 始终是 index.html 或 site-assets/<内置文件名>，使用 POSIX 分隔符。

const previewHtml = await renderWebsitePreview(config as WebsiteConfig);
// Promise<string>：完整 HTML，内置图全部为 data URI，适合 iframe srcdoc 预览。
// 包括 favicon、动态作品墙及管理员覆盖图片失败时的内置回退；远程图片仍使用原 URL。

const images = await builtinWebsiteImages();
// Promise<Record<string, string>>：内置文件名（例如 logo-full.svg） → data URI。
// 管理接口可用 images[SITE_IMAGE_SLOTS[slot].file] 生成图片列表。
```

`WebsiteConfig` 的字段为 `enabled`、`version`、`sizeNote`、`downloadUrl`、`backupUrl`、`contacts`（`bd/support/wechat/qq`）、`icp`、`showStats`、`showChannels`、`images`、`announcements` 和 `releases`。类型定义完整位于 `render.ts`，服务端无需向官网暴露配置接口。

## 验证

```powershell
node website/verify.mjs
```

该验证使用合成配置和系统临时目录，检查公开字段过滤、脚本注入转义、静态资源与预览、闭站备案链接、CLI 压缩包及拒绝覆盖，不访问生产或真实 OSS。
