import { registerAdapter } from "./registry";
import { mockAdapter } from "./mockAdapter";

/**
 * 内置适配器注册。
 *
 * 旧的 gvlm / libImage / libAudio / seedance 五个直连第三方的适配器已删除；
 * 真实模型一律由管理端 catalog 下发，经 ManagedAdapter 统一接入
 * （见 syncManagedAdapters，由 catalogStore.syncCatalog 自动调用）。
 *
 * 这里只保留 mockAdapter 作为离线/无目录时的本地兜底。
 */
registerAdapter(mockAdapter);
