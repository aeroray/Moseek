import { useEffect, useRef } from "react";
import Hls from "hls.js";
import Plyr from "plyr";
import "plyr/dist/plyr.css";

import type { MediaKind } from "@/types/moseek";

export type MediaStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

interface MediaPlayerProps {
  title: string;
  url: string;
  kind: MediaKind;
  headers?: Record<string, string>;
  poster?: string;
  resumeAt?: number;
  onProgress?: (seconds: number) => void;
  onStatus?: (status: MediaStatus, message?: string) => void;
}

export function MediaPlayer({
  title,
  url,
  kind,
  headers,
  poster,
  resumeAt = 0,
  onProgress,
  onStatus,
}: MediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const callbackRef = useRef({ onProgress, onStatus });
  const resumeRef = useRef(resumeAt);

  useEffect(() => {
    callbackRef.current = { onProgress, onStatus };
    resumeRef.current = resumeAt;
  }, [onProgress, onStatus, resumeAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastProgress = -1;
    const report = (status: MediaStatus, message?: string) => {
      callbackRef.current.onStatus?.(status, message);
    };
    const createPlayer = () => {
      const player = new Plyr(video, {
        autoplay: false,
        seekTime: 10,
        settings: ["quality", "speed"],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        controls: [
          "play-large",
          "restart",
          "play",
          "progress",
          "current-time",
          "duration",
          "mute",
          "volume",
          "settings",
          "pip",
          "fullscreen",
        ],
      });
      playerRef.current = player;
      player.on("ready", () => {
        const resume = resumeRef.current;
        if (
          resume > 5 &&
          Number.isFinite(player.duration) &&
          player.duration > resume
        ) {
          player.currentTime = resume;
        }
        report("ready");
      });
      player.on("playing", () => report("playing"));
      player.on("pause", () => report("paused"));
      player.on("ended", () => report("ended"));
      player.on("error", () => report("error", "Plyr 无法播放当前媒体地址。"));
      player.on("timeupdate", () => {
        const currentTime = player.currentTime;
        if (Number.isFinite(currentTime) && currentTime - lastProgress >= 5) {
          lastProgress = currentTime;
          callbackRef.current.onProgress?.(currentTime);
        }
      });
      return player;
    };

    report("loading");
    video.poster = poster ?? "";
    const isHls = kind === "hls" || url.toLowerCase().includes(".m3u8");
    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        xhrSetup: (xhr) => {
          Object.entries(headers ?? {}).forEach(([name, value]) => {
            xhr.setRequestHeader(name, value);
          });
        },
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          report("error", `HLS 播放失败：${data.details || "媒体流错误"}`);
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        createPlayer();
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
      createPlayer();
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [headers, kind, poster, title, url]);

  return (
    <div
      className="overflow-hidden rounded-md bg-black shadow-2xl ring-1 ring-border/40"
      style={{ "--plyr-color-main": "var(--primary)" } as React.CSSProperties}
    >
      <video ref={videoRef} className="aspect-video w-full" playsInline />
    </div>
  );
}
