import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extracts a human-readable message from whatever a rejected promise carried.
 *
 * This matters more than it looks. A Tauri command that returns `Err(String)` rejects its JS
 * promise with a **plain string**, not an `Error` — the IPC layer serialises `InvokeError`'s value
 * directly and the injected `invoke` calls `reject(e)` with it. So `error instanceof Error` is
 * false for every backend failure, and a call site written as
 * `error instanceof Error ? error.message : "播放地址未通过安全检查"` discards the real reason and
 * substitutes the fallback.
 *
 * That is exactly how "播放地址未通过安全检查" reached the user: fifty-five parser services had
 * failed and timed out, and the one message that would have said so was thrown away.
 *
 * The order matters: `Error` first, then a non-empty string, then an object carrying `message`
 * (a plugin error), and only then the caller's fallback.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}
