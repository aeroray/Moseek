import type { EpgProgram, LiveChannel, LiveGroup } from "@/types/moseek";

const hlsDemo = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const mp4Demo = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

export const mockLiveGroups: LiveGroup[] = [
  { id: "news", name: "新闻" },
  { id: "sports", name: "体育" },
  { id: "culture", name: "文化" },
  { id: "kids", name: "少儿" },
];

export const mockLiveChannels: LiveChannel[] = [
  { id: "news-1", name: "城市新闻", groupId: "news", groupName: "新闻", logoUrl: "", streamUrl: hlsDemo, mediaKind: "hls", sourceKey: "live-main" },
  { id: "news-2", name: "全球视线", groupId: "news", groupName: "新闻", logoUrl: "", streamUrl: mp4Demo, mediaKind: "mp4", sourceKey: "live-main" },
  { id: "sports-1", name: "赛事现场", groupId: "sports", groupName: "体育", logoUrl: "", streamUrl: hlsDemo, mediaKind: "hls", sourceKey: "live-main" },
  { id: "sports-2", name: "球场回放", groupId: "sports", groupName: "体育", logoUrl: "", streamUrl: mp4Demo, mediaKind: "mp4", sourceKey: "live-main" },
  { id: "culture-1", name: "纪录片频道", groupId: "culture", groupName: "文化", logoUrl: "", streamUrl: mp4Demo, mediaKind: "mp4", sourceKey: "live-main" },
  { id: "culture-2", name: "城市读本", groupId: "culture", groupName: "文化", logoUrl: "", streamUrl: hlsDemo, mediaKind: "hls", sourceKey: "live-main" },
  { id: "kids-1", name: "星星少儿", groupId: "kids", groupName: "少儿", logoUrl: "", streamUrl: mp4Demo, mediaKind: "mp4", sourceKey: "live-main" },
];

export const mockEpgPrograms: EpgProgram[] = [
  { id: "epg-news-1", channelId: "news-1", title: "早间城市", description: "本地交通、天气与城市动态。", startAt: "07:30", endAt: "09:00" },
  { id: "epg-news-2", channelId: "news-1", title: "今日焦点", description: "从现场出发，梳理今天的重要新闻。", startAt: "09:00", endAt: "10:30" },
  { id: "epg-sports-1", channelId: "sports-1", title: "赛事现场", description: "今日重点赛事直播。", startAt: "08:30", endAt: "11:00" },
  { id: "epg-sports-2", channelId: "sports-1", title: "赛后分析", description: "数据、战术与现场声音。", startAt: "11:00", endAt: "12:00" },
  { id: "epg-culture-1", channelId: "culture-1", title: "远方的手艺", description: "记录正在消失的地方技艺。", startAt: "08:00", endAt: "09:30" },
  { id: "epg-kids-1", channelId: "kids-1", title: "星球旅行队", description: "一场给小朋友的自然观察之旅。", startAt: "08:00", endAt: "09:00" },
];
