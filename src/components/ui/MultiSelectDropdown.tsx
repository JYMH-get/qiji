import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface MultiSelectGroup {
  label: string;
  items: { id: string; label: string; selected: boolean }[];
}

interface MultiSelectDropdownProps {
  groups: MultiSelectGroup[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  placeholder?: string;
}

export function MultiSelectDropdown({
  groups,
  selectedIds,
  onToggle,
  placeholder = "选择模型...",
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedCount = selectedIds.length;

  return (
    <div className="relative">
      {/* 触发按钮 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[10px] cursor-pointer transition-colors"
        style={{
          background: "var(--secondary)",
          borderColor: "var(--border)",
          color: "var(--foreground)",
        }}
      >
        <span className="truncate">
          {selectedCount > 0 ? `已选 ${selectedCount} 个模型` : placeholder}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 transition-transform"
          style={{
            opacity: 0.6,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {/* 下拉面板 */}
      {open && (
        <div
          ref={panelRef}
          className="absolute z-50 mt-1 w-full rounded-lg border shadow-lg overflow-hidden"
          style={{
            background: "var(--popover)",
            borderColor: "var(--border)",
            maxHeight: "260px",
          }}
        >
          <div className="overflow-y-auto" style={{ maxHeight: "260px" }}>
            {groups.length === 0 && (
              <div className="px-3 py-4 text-center text-[10px]" style={{ color: "var(--muted-foreground)" }}>
                暂无可用模型
              </div>
            )}
            {groups.map((group) => (
              <div key={group.label}>
                {/* 分组标题 */}
                <div
                  className="px-3 py-1.5 text-[9px] font-semibold sticky top-0"
                  style={{
                    background: "var(--secondary)",
                    color: "var(--muted-foreground)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {group.label}
                </div>
                {/* 分组选项 */}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onToggle(item.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] cursor-pointer transition-colors"
                    style={{
                      background: item.selected
                        ? "color-mix(in srgb, var(--primary) 12%, transparent)"
                        : "transparent",
                      color: "var(--foreground)",
                    }}
                    onMouseEnter={(e) => {
                      if (!item.selected) {
                        (e.currentTarget as HTMLButtonElement).style.background = "var(--secondary)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!item.selected) {
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }
                    }}
                  >
                    <span
                      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border"
                      style={{
                        borderColor: item.selected ? "var(--primary)" : "var(--border)",
                        background: item.selected ? "var(--primary)" : "transparent",
                      }}
                    >
                      {item.selected && <Check className="h-2.5 w-2.5" style={{ color: "var(--primary-foreground)" }} />}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}