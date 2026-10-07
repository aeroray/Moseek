import { useCallback, useEffect, useRef, useState } from "react";

import { probeStreamUrls, type StreamProbe } from "@/lib/tauri";

export interface StreamProbes {
  /** Null until a probe has run, or when probing is unavailable or was skipped. */
  probes: StreamProbe[] | null;
  isProbing: boolean;
  /** Index into the caller's URL list of the line currently being played. */
  streamIndex: number;
  /** Chooses a line deliberately; this outranks the probe's own choice. */
  selectStream: (index: number) => void;
  /** The probe result for a line, if one has arrived. */
  probeFor: (index: number) => StreamProbe | undefined;
}

/**
 * Tests every line of a channel at once and starts on the one that answers fastest.
 *
 * Extracted from the live workspace so the favourites page plays a saved channel through exactly
 * the same logic. The subtle parts — the concurrent call, the "only move if the current line is
 * not itself usable" rule, and degrading to no results when the command is unavailable — are
 * worth having in one place; a second copy would drift and the difference would show up as
 * "this channel plays in 电视直播 but not in 我的收藏".
 *
 * Lines used to be tried strictly in order, so the player spent its whole timeout failing on
 * line 1 before line 2 was attempted. One parallel pass replaces that serial wait.
 */
export function useStreamProbes(
  streamUrls: string[],
  /**
   * Identity of the thing being played. Two different channels can carry an identical URL list,
   * so keying the reset on the URLs alone would leave the previous channel's line selection in
   * place when switching between them.
   */
  resetKey: string,
): StreamProbes {
  const [probes, setProbes] = useState<StreamProbe[] | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [streamIndex, setStreamIndex] = useState(0);
  const indexRef = useRef(0);
  /** A deliberate choice suppresses the automatic override for this channel. */
  const pinnedRef = useRef(false);

  const selectStream = useCallback((index: number) => {
    pinnedRef.current = true;
    indexRef.current = index;
    setStreamIndex(index);
  }, []);

  // A new channel starts over: back to its first line, unpinned, with no stale results.
  const streamUrlsKey = streamUrls.join("|");
  useEffect(() => {
    indexRef.current = 0;
    pinnedRef.current = false;
    setStreamIndex(0);
    setProbes(null);
  }, [resetKey, streamUrlsKey]);

  useEffect(() => {
    let cancelled = false;
    if (pinnedRef.current || streamUrls.length < 2) {
      setIsProbing(false);
      return () => {
        cancelled = true;
      };
    }
    setIsProbing(true);
    // `probeStreamUrls` returns null outside the desktop runtime, where the command is not
    // registered. Calling `.then` on that crashed the whole workspace — the channel list and the
    // player both disappeared, so a preview build could not play anything with more than one
    // line. Probing is an optimisation, so its absence must degrade to "no probe results".
    void Promise.resolve(probeStreamUrls(streamUrls))
      .then((results) => {
        if (cancelled) return;
        setProbes(results);
        if (!results || pinnedRef.current) return;
        // Pick the quickest reachable line here rather than trusting the backend's ordering, so
        // the choice stays correct even if the list arrives unsorted.
        const fastest = results
          .filter((probe) => probe.ok)
          .reduce<StreamProbe | null>(
            (best, probe) =>
              !best || probe.elapsedMs < best.elapsedMs ? probe : best,
            null,
          );
        if (!fastest) return;
        // Only move if the current line is not itself usable, so a working default is not
        // disturbed.
        const current = results.find(
          (probe) => probe.index === indexRef.current,
        );
        if (!current?.ok) {
          indexRef.current = fastest.index;
          setStreamIndex(fastest.index);
        }
      })
      .catch(() => {
        // A failed probe is not a failure to play: the player still gets the selected line.
        if (!cancelled) setProbes(null);
      })
      .finally(() => {
        if (!cancelled) setIsProbing(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the URL list rather than the array, which is rebuilt on every render, plus the
    // caller's identity so switching between two channels that share a URL list still re-probes.
  }, [resetKey, streamUrlsKey]);

  const probeFor = useCallback(
    (index: number) => probes?.find((probe) => probe.index === index),
    [probes],
  );

  return { probes, isProbing, streamIndex, selectStream, probeFor };
}
