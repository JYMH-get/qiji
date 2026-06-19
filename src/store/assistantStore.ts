import { create } from "zustand";

/* ------------------------------------------------------------------ */
/*  ChatMessage                                                       */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 引用的画布节点 ID 列表 */
  refNodeIds?: string[];
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Panel 状态                                                        */
/* ------------------------------------------------------------------ */

interface AssistantState {
  /** 面板是否展开 */
  open: boolean;
  /** 历史消息 */
  messages: ChatMessage[];
  /** 当前正在流式输出（助手回复中） */
  streaming: boolean;

  togglePanel: () => void;
  setOpen: (open: boolean) => void;
  addMessage: (msg: ChatMessage) => void;
  appendToLast: (delta: string) => void;
  setStreaming: (v: boolean) => void;
  clearMessages: () => void;
}

let _id = 0;
function nextId() {
  return `chat-${Date.now()}-${++_id}`;
}

/** 持久化 key */
const STORAGE_KEY = "Qiji:assistantMessages";

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function persistMessages(msgs: ChatMessage[]) {
  try {
    // 只保留最近 200 条，防止 localStorage 膨胀
    const slice = msgs.slice(-200);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {}
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  messages: loadMessages(),
  streaming: false,

  togglePanel: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),

  addMessage: (msg) => {
    const id = msg.id || nextId();
    const finalMsg = { ...msg, id };
    set((s) => {
      const next = [...s.messages, finalMsg];
      persistMessages(next);
      return { messages: next };
    });
  },

  appendToLast: (delta) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content: last.content + delta };
        persistMessages(msgs);
      }
      return { messages: msgs };
    });
  },

  setStreaming: (streaming) => set({ streaming }),

  clearMessages: () => {
    set({ messages: [] });
    persistMessages([]);
  },
}));