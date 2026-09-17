import * as React from "react";

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastIcon,
  ToastTitle,
} from "@/components/ui/toast";

export interface ToastMessage {
  title: string;
  description?: string;
  variant?: "info" | "success" | "error";
}

const ToastContext = React.createContext<((message: ToastMessage) => void) | null>(
  null,
);

/**
 * Renders one toast at a time from a queue, newest first.
 *
 * A notice replaces the previous one rather than stacking: these report the outcome of a single
 * operation, and a column of stale results would be harder to read than the latest one. Radix
 * still owns the enter/exit animation and the auto-dismiss timer.
 */
export function ToastHost({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = React.useState<
    Array<ToastMessage & { id: number }>
  >([]);
  const nextId = React.useRef(0);

  const push = React.useCallback((message: ToastMessage) => {
    nextId.current += 1;
    const id = nextId.current;
    // Keep only the newest: an operation reports its result once, and a backlog of earlier
    // results would outlive the moment they described.
    setMessages([{ ...message, id }]);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {messages.map((message) => (
        <Toast
          key={message.id}
          variant={message.variant ?? "info"}
          open
          onOpenChange={(open) => {
            if (!open) setMessages((current) => current.filter((m) => m.id !== message.id));
          }}
        >
          <ToastIcon variant={message.variant ?? "info"} />
          <div className="min-w-0 flex-1">
            <ToastTitle>{message.title}</ToastTitle>
            {message.description && (
              <ToastDescription>{message.description}</ToastDescription>
            )}
          </div>
          <ToastClose />
        </Toast>
      ))}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = React.useContext(ToastContext);
  if (!push) {
    throw new Error("useToast 必须在 ToastHost 内使用");
  }
  return push;
}

/**
 * The toast channel if one is mounted, otherwise a no-op.
 *
 * Components that merely *report* an outcome should not require a host to render: the poster
 * viewer is reachable from any card, and a missing toast host is a reason to stay silent, not a
 * reason to fail. Components that are themselves a notification still use `useToast` and still
 * throw, because for them a missing host means the notification would vanish.
 */
export function useOptionalToast() {
  return React.useContext(ToastContext) ?? noopToast;
}

const noopToast = () => {};
