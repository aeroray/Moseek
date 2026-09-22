/**
 * When the live startup watchdog should act.
 *
 * Extracted from `MediaPlayer` because the rule is the whole fix and it was previously impossible
 * to test: it lived inside a large effect closure, so nothing could assert on it, and the defect it
 * now prevents shipped.
 *
 * The defect: the watchdog fired a flat 10 seconds after loading began and its recovery called
 * `stopLoad()`, which aborts the fragment request that is in flight. A public source delivering a
 * 1.9 MB fragment over 12.4 seconds was therefore cancelled roughly 2.4 seconds before the fragment
 * would have arrived, three times in a row — and on the third the recovery budget was exhausted, so
 * the player reported "直播流长时间没有收到可播放分片" and showed the failure surface. Because that
 * last request was no longer being cancelled, it then completed normally and playback started on its
 * own, which is precisely the "it said it failed, then started playing by itself" the user reported.
 */
export type LiveWatchdogDecision =
  /** Nothing left to watch for. */
  | "stop"
  /** A request is outstanding and the attempt still has budget: waiting is the correct action. */
  | "postpone"
  /** The attempt has genuinely stalled: recover, or give up. */
  | "fire";

export function decideLiveWatchdog(input: {
  /** A fragment has been demuxed and buffered, so the picture is on its way. */
  hasBufferedFragment: boolean;
  /** A playlist or fragment request has not settled yet. */
  requestInFlight: boolean;
  now: number;
  /** When the current load attempt runs out of budget. Fixed for the attempt. */
  deadlineAt: number;
}): LiveWatchdogDecision {
  if (input.hasBufferedFragment) return "stop";
  // A request that has not settled has not failed. Aborting it is what turned a working stream
  // into a reported failure, so it is given the attempt's remaining budget.
  if (input.requestInFlight && input.now < input.deadlineAt) return "postpone";
  return "fire";
}

/**
 * Whether a status change means an earlier failure note is no longer true.
 *
 * A recovered pipeline must clear the failure text. The watchdog can give up and the fragment it
 * was waiting for can still arrive moments later, so the page can legitimately go from 播放失败 to
 * 正在播放 without anything being re-requested — and leaving the old note in place produced a report
 * that contradicted itself, with 播放状态：正在播放 beside a 前置提示 saying no segment ever arrived.
 */
export function clearsFailureNote(status: string) {
  return status !== "error";
}
