import React from "react";
import { RotateCcw } from "lucide-react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Canvas 错误边界：捕获 React 渲染错误，防止整个画布崩溃。
 * 参考项目的做法：节点级 status 状态机，错误不传播到画布级别。
 * Qiji 的改进：增加全局错误边界作为最后防线。
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[CanvasErrorBoundary] 渲染错误:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0a0b0f] text-[#e8eaf0]">
          <div className="flex flex-col items-center gap-2">
            <div className="text-2xl font-bold text-red-400/80">
              画布渲染异常
            </div>
            <div className="max-w-md text-center text-sm text-muted-foreground leading-relaxed">
              {this.state.error?.message || "未知错误"}
            </div>
          </div>
          <button
            onClick={this.handleReset}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-foreground/80 transition hover:bg-white/10 hover:text-foreground cursor-pointer"
          >
            <RotateCcw className="h-4 w-4" />
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}