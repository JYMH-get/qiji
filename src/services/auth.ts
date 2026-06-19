import { BACKEND_API_URL } from "./config";

interface AuthState {
  isActivated: boolean;
  userId: string | null;
  token: string | null;
  userName: string | null;
  credits: {
    total: number;
    consumed: number;
    remaining: number;
  } | null;
}

// 运行时检测是否在 Tauri 环境
function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// 动态获取 Tauri API
async function getTauriFs() {
  const { exists, writeTextFile, readTextFile, mkdir } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return { exists, writeTextFile, readTextFile, mkdir, appDataDir, join };
}

let cachedMachineId: string | null = null;

/**
 * 获取或初始化当前设备的唯一机器码。
 * 在 Tauri 环境下，保存在本地 AppData/machine.id 文件中以防清理缓存丢失。
 * 在网页环境下，保存在 LocalStorage 中。
 */
export async function getMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;

  if (isTauri()) {
    try {
      const { exists, writeTextFile, readTextFile, mkdir, appDataDir, join } = await getTauriFs();
      const appDir = await appDataDir();
      
      // 确保 AppData 目录存在
      if (!(await exists(appDir))) {
        await mkdir(appDir, { recursive: true });
      }

      const idPath = await join(appDir, "machine.id");
      if (await exists(idPath)) {
        const fileContent = await readTextFile(idPath);
        cachedMachineId = fileContent.trim();
      } else {
        const newId = `mac-${Math.random().toString(36).substring(2, 15)}-${Date.now().toString(36)}`;
        await writeTextFile(idPath, newId);
        cachedMachineId = newId;
      }
      return cachedMachineId;
    } catch (err) {
      console.error("Tauri 获取机器码失败，降级为 LocalStorage", err);
    }
  }

  // 网页端或 Tauri 降级
  let browserId = localStorage.getItem("qiji_machine_id");
  if (!browserId) {
    browserId = `browser-${Math.random().toString(36).substring(2, 15)}-${Date.now().toString(36)}`;
    localStorage.setItem("qiji_machine_id", browserId);
  }
  cachedMachineId = browserId;
  return cachedMachineId;
}

// 内存中缓存的授权状态
let currentAuthState: AuthState = {
  isActivated: false,
  userId: null,
  token: null,
  userName: null,
  credits: null,
};

export function getAuthState(): AuthState {
  return currentAuthState;
}

/**
 * 首次激活设备并绑定激活码
 */
export async function activateClient(activationCode: string): Promise<{ success: boolean; error?: string }> {
  try {
    const machineId = await getMachineId();
    const res = await fetch(`${BACKEND_API_URL}/auth/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activation_code: activationCode.trim(),
        machine_code: machineId,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      return { success: false, error: data.error || "激活失败" };
    }

    const data = await res.json();
    
    // 缓存至本地
    localStorage.setItem("qiji_activation_code", activationCode);
    localStorage.setItem("qiji_auth_token", data.token);

    currentAuthState = {
      isActivated: true,
      userId: data.userId,
      token: data.token,
      userName: data.user?.name || `用户_${activationCode.slice(-4)}`,
      credits: data.credits || null,
    };

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "请求服务器失败" };
  }
}

/**
 * 启动时进行静默授权校验
 */
export async function verifyActivation(): Promise<boolean> {
  const token = localStorage.getItem("qiji_auth_token");
  const code = localStorage.getItem("qiji_activation_code");

  if (!token || !code) {
    currentAuthState.isActivated = false;
    return false;
  }

  try {
    const machineId = await getMachineId();
    const res = await fetch(`${BACKEND_API_URL}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine_code: machineId,
        token: token,
      }),
    });

    if (!res.ok) {
      // 验证失效，清空本地缓存
      localStorage.removeItem("qiji_auth_token");
      currentAuthState.isActivated = false;
      return false;
    }

    const data = await res.json();
    currentAuthState = {
      isActivated: true,
      userId: data.user.id,
      token: token,
      userName: data.user.name,
      credits: data.credits || null,
    };
    return true;
  } catch (err) {
    console.error("静默验证失败 (可能是服务器不可达):", err);
    // 离线环境：假定验证通过，本地缓存依然有效（除模型运行会报错外，仍可进行本地渲染编辑）
    currentAuthState = {
      isActivated: true,
      userId: "offline-user",
      token: token,
      userName: "离线用户",
      credits: { total: 1000, consumed: 0, remaining: 1000 },
    };
    return true;
  }
}

/**
 * 退出登录/注销激活
 */
export function deactivateClient() {
  localStorage.removeItem("qiji_activation_code");
  localStorage.removeItem("qiji_auth_token");
  currentAuthState = {
    isActivated: false,
    userId: null,
    token: null,
    userName: null,
    credits: null,
  };
}
