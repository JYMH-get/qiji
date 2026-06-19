/**
 * projectZip — ZIP 导出/导入
 *
 * 导出：project.Qiji JSON + assets/ 目录内所有媒体文件打包为 .zip
 * 导入：解压 .zip，读取 project.Qiji，可选恢复 assets/
 */
import JSZip from "jszip";
import type { QijiProject } from "./projectFile";

export interface ZipExportResult {
  blob: Blob;
  filename: string;
}

/**
 * 将项目导出为 ZIP：project.Qiji + assets/ 下所有本地文件
 */
export async function exportProjectZip(
  project: QijiProject,
  assetFiles?: { path: string; data: Uint8Array }[],
): Promise<ZipExportResult> {
  const zip = new JSZip();

  // 1. 写入 project.Qiji
  const projectJson = JSON.stringify(project, null, 2);
  zip.file("project.Qiji", projectJson);

  // 2. 打包 assets（如果有）
  if (assetFiles && assetFiles.length > 0) {
    const assetsFolder = zip.folder("assets");
    if (assetsFolder) {
      for (const asset of assetFiles) {
        const filename = asset.path.split(/[/\\]/).pop() || `asset-${Date.now()}`;
        assetsFolder.file(filename, asset.data);
      }
    }
  }

  // 3. 写入 manifest
  const manifest = {
    format: "Qiji-ZIP",
    version: "1.0",
    projectVersion: project.version,
    projectName: project.name,
    exportedAt: new Date().toISOString(),
    assetCount: assetFiles?.length ?? 0,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_");

  return { blob, filename: `${safeName}.qiji.zip` };
}

/**
 * 从 ZIP 导入项目：返回解析后的 QijiProject
 */
export async function importProjectZip(file: File): Promise<QijiProject | null> {
  try {
    const zip = await JSZip.loadAsync(file);

    // 读取 project.Qiji
    const projectFile = zip.file("project.Qiji");
    if (!projectFile) {
      console.error("ZIP 中未找到 project.Qiji");
      return null;
    }

    const projectJson = await projectFile.async("text");
    const project: QijiProject = JSON.parse(projectJson);

    return project;
  } catch (err) {
    console.error("导入 ZIP 失败:", err);
    return null;
  }
}