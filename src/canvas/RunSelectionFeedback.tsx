import { useEffect } from "react";
import { useRunSelectionFeedback } from "./runSelection";

export function RunSelectionFeedback() {
  const { message, revision } = useRunSelectionFeedback();
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => useRunSelectionFeedback.setState({ message: null }), 5000);
    return () => clearTimeout(timer);
  }, [message, revision]);
  if (!message) return null;
  return <div role="status" className="Qiji-panel fixed bottom-6 left-1/2 z-[10401] -translate-x-1/2 rounded-xl px-4 py-2 text-xs text-foreground shadow-xl">{message}</div>;
}
