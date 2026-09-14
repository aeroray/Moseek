import type {
  CatalogPage,
  VodCategory,
  VodEpisode,
  VodItem,
  VodPlayLine,
} from "@/types/moseek";

const posters = [
  "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1440404653325-ab127d49abc1?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1518929458119-e5bf444c30f4?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=640&q=80",
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80",
];

const category = (id: string, name: string): VodCategory => ({ id, name });
const demoHlsUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const demoMp4Url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

function episodes(itemId: string, count: number, url: string): VodEpisode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${itemId}-episode-${index + 1}`,
    name: `第 ${index + 1} 集`,
    url,
  }));
}

function lines(itemId: string, count: number): VodPlayLine[] {
  return [
    {
      id: `${itemId}-line-main`,
      name: "高清线路",
      episodes: episodes(itemId, count, demoHlsUrl),
    },
    {
      id: `${itemId}-line-backup`,
      name: "备用线路",
      episodes: episodes(`${itemId}-backup`, count, demoMp4Url),
    },
  ];
}

export const mockVodItems: VodItem[] = [
  {
    id: "fog-harbor-letter",
    sourceKey: "clzy",
    sourceName: "初恋资源",
    name: "雾港来信",
    poster: posters[0],
    description: "一封迟到多年的信，把海港小城里几段被遗忘的关系重新牵到一起。",
    year: "2025",
    area: "中国大陆",
    categories: [category("drama", "剧情"), category("mystery", "悬疑")],
    actors: ["林南", "周野", "沈宁"],
    directors: ["顾行舟"],
    playLines: lines("fog-harbor-letter", 12),
  },
  {
    id: "blue-echo",
    sourceKey: "ikunzy",
    sourceName: "ikunzy",
    name: "蓝色回声",
    poster: posters[1],
    description: "潜水员在深海记录仪里听见一段不属于这个时代的声音。",
    year: "2024",
    area: "中国大陆",
    categories: [
      category("science-fiction", "科幻"),
      category("mystery", "悬疑"),
    ],
    actors: ["许澄", "贺川"],
    directors: ["陆屿"],
    playLines: lines("blue-echo", 8),
  },
  {
    id: "long-rain-season",
    sourceKey: "豪华资源",
    sourceName: "豪华资源",
    name: "漫长的雨季",
    poster: posters[2],
    description: "一座南方小城连续下了九十天雨，四个陌生人开始共享同一个秘密。",
    year: "2025",
    area: "中国大陆",
    categories: [category("drama", "剧情"), category("romance", "爱情")],
    actors: ["程野", "宋清"],
    directors: ["何其安"],
    playLines: lines("long-rain-season", 16),
  },
  {
    id: "silent-testimony",
    sourceKey: "hnzy",
    sourceName: "hnzy",
    name: "无声的证词",
    poster: posters[3],
    description: "旧案重启之后，唯一的证人用一卷录音带指向了意料之外的真相。",
    year: "2023",
    area: "中国大陆",
    categories: [category("crime", "犯罪"), category("mystery", "悬疑")],
    actors: ["陈默", "方言"],
    directors: ["苏砚"],
    playLines: lines("silent-testimony", 10),
  },
  {
    id: "orbital-repair-station",
    sourceKey: "gszy",
    sourceName: "gszy",
    name: "星际维修站",
    poster: posters[4],
    description: "偏远轨道上的维修站收到一艘失联飞船的求救信号。",
    year: "2024",
    area: "美国",
    categories: [
      category("science-fiction", "科幻"),
      category("adventure", "冒险"),
    ],
    actors: ["Mara Cole", "Jon Bell"],
    directors: ["A. Hunter"],
    playLines: lines("orbital-repair-station", 6),
  },
  {
    id: "unfinished-summer",
    sourceKey: "lzzy",
    sourceName: "lzzy",
    name: "未完的夏天",
    poster: posters[5],
    description: "毕业前的最后一个夏天，老朋友们决定把一场未完成的旅行走到底。",
    year: "2022",
    area: "中国大陆",
    categories: [category("romance", "爱情"), category("comedy", "喜剧")],
    actors: ["江屿", "苏禾"],
    directors: ["唐安"],
    playLines: lines("unfinished-summer", 24),
  },
  {
    id: "last-train",
    sourceKey: "snzy",
    sourceName: "snzy",
    name: "最后一班列车",
    poster: posters[6],
    description: "每晚十一点四十七分，终点站总会多出一个不在乘客名单上的人。",
    year: "2025",
    area: "日本",
    categories: [category("mystery", "悬疑"), category("thriller", "惊悚")],
    actors: ["北川遥", "森川诚"],
    directors: ["小野寺"],
    playLines: lines("last-train", 10),
  },
  {
    id: "coastline-outside",
    sourceKey: "clzy",
    sourceName: "初恋资源",
    name: "海岸线之外",
    poster: posters[7],
    description: "摄影师沿着海岸线寻找失踪的哥哥，也重新认识了自己的故乡。",
    year: "2021",
    area: "中国大陆",
    categories: [category("documentary", "纪录片"), category("drama", "剧情")],
    actors: ["赵屿"],
    directors: ["许望"],
    playLines: lines("coastline-outside", 1),
  },
];

export function getMockCatalog(
  sourceKey: string,
  query: string,
  categoryId: string,
  page: number,
  pageSize: number,
): CatalogPage {
  const sourceItems = mockVodItems.filter(
    (item) => item.sourceKey === sourceKey,
  );
  const categories = collectCategories(sourceItems);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = sourceItems.filter((item) => {
    const matchesQuery =
      !normalizedQuery ||
      [item.name, item.description, item.year, item.area]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    const matchesCategory =
      categoryId === "all" ||
      item.categories.some((itemCategory) => itemCategory.id === categoryId);
    return matchesQuery && matchesCategory;
  });
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * pageSize;

  return {
    sourceKey,
    items: filteredItems.slice(start, start + pageSize),
    categories,
    page: safePage,
    pageCount,
    pageSize,
    total: filteredItems.length,
  };
}

export function getMockDetail(itemId: string) {
  return mockVodItems.find((item) => item.id === itemId) ?? null;
}

function collectCategories(items: VodItem[]) {
  const categoryMap = new Map<string, VodCategory>();
  items.forEach((item) => {
    item.categories.forEach((itemCategory) =>
      categoryMap.set(itemCategory.id, itemCategory),
    );
  });
  return [...categoryMap.values()];
}
