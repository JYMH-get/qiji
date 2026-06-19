import type { ModelAdapter } from "./types";

/** 本地联调用的 mock 提交/轮询，不真正调模型。 */
export function mockIO(): Pick<ModelAdapter, "submit" | "poll"> {
  return {
    async submit(input: any, params: any) {
      const rand = Math.random().toString(36).slice(2, 8);
      const taskId = `task-${Date.now().toString(36)}-${rand}`;
      printLLMRequest(`MockAdapter:Submit`, "SIMULATED_LOCAL_MOCK_URL", "POST", { "Content-Type": "application/json" }, { input, params });
      return { taskId };
    },
    async poll(taskId: string) {
      const resultUri = "about:blank";
      printLLMResponse(`MockAdapter:Poll`, 200, 50, { taskId, status: "success", progress: 100, resultUri });
      return { status: "success", progress: 100, resultUri };
    },
  };
}

export function num(params: Record<string, unknown>, key: string, fallback: number) {
  const v = Number(params[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function truncateBase64(obj: any): any {
  if (typeof obj === 'string') {
    // 1. Data URLs with base64 prefix
    if (obj.startsWith('data:') && obj.includes(';base64,')) {
      const parts = obj.split(';base64,');
      const prefix = parts[0] + ';base64,';
      const base64Content = parts[1];
      return `${prefix}${base64Content.substring(0, 100)}... [truncated base64, total length: ${base64Content.length}]`;
    }
    // 2. Raw base64 string (often used in OpenAI b64_json)
    if (obj.length > 200 && /^[A-Za-z0-9+/=]+$/.test(obj)) {
      return `${obj.substring(0, 100)}... [truncated base64, total length: ${obj.length}]`;
    }
    // 3. Stringified JSON containing base64 data
    if (obj.includes(';base64,')) {
      return obj.replace(/(data:[^;]+;base64,)([A-Za-z0-9+/=]{100,})/g, (_, prefix, base64) => {
        return `${prefix}${base64.substring(0, 100)}... [truncated base64, total length: ${base64.length}]`;
      });
    }
    return obj;
  }
  if (typeof FormData !== 'undefined' && obj instanceof FormData) {
    const res: Record<string, any> = {};
    obj.forEach((value, key) => {
      if (value instanceof Blob) {
        res[key] = `Blob(${value.size} bytes, ${value.type})`;
      } else {
        res[key] = truncateBase64(value);
      }
    });
    return res;
  }
  if (typeof Blob !== 'undefined' && obj instanceof Blob) {
    return `Blob(${obj.size} bytes, ${obj.type})`;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateBase64(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const res: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        res[key] = truncateBase64(obj[key]);
      }
    }
    return res;
  }
  return obj;
}

export function printLLMRequest(label: string, url: string, method: string, headers: any, body: any) {
  const headersObj = headers instanceof Headers 
    ? Object.fromEntries(headers.entries()) 
    : { ...(headers || {}) };

  if (headersObj.Authorization) {
    headersObj.Authorization = headersObj.Authorization.replace(/Bearer\s+(.+)/i, (_: string, token: string) => {
      if (token.length > 8) {
        return `Bearer ${token.substring(0, 4)}***${token.substring(token.length - 4)}`;
      }
      return 'Bearer ***';
    });
  }
  
  console.log(
    `%c[LLM Request - ${label}]%c\n` +
    `URL: ${url}\n` +
    `Method: ${method}\n` +
    `Headers: ${JSON.stringify(headersObj, null, 2)}\n` +
    `Body: ${typeof body === 'string' ? truncateBase64(body) : JSON.stringify(truncateBase64(body), null, 2)}`,
    'color: #8b5cf6; font-weight: bold;',
    ''
  );
}

export function printLLMResponse(label: string, status: number, durationMs: number, body: any) {
  console.log(
    `%c[LLM Response - ${label}]%c\n` +
    `Status: ${status}\n` +
    `Duration: ${durationMs}ms\n` +
    `Body: ${typeof body === 'string' ? truncateBase64(body) : JSON.stringify(truncateBase64(body), null, 2)}`,
    'color: #10b981; font-weight: bold;',
    ''
  );
}

export function printLLMError(label: string, durationMs: number, error: any) {
  console.error(
    `%c[LLM Error - ${label}]%c\n` +
    `Duration: ${durationMs}ms\n` +
    `Error: ${error?.message || String(error)}`,
    'color: #ef4444; font-weight: bold;',
    ''
  );
}