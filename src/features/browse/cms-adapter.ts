import {
  browseSource,
  executeScriptArchive,
  getDetail,
  isTauriRuntime,
} from "@/lib/tauri";
import {
  normalizeCatVodResult,
  type CatVodMethod,
} from "@/features/script/catvod-normalizer";
import { hasScriptArchive } from "@/lib/adapters";
import type { CatalogPage, SourceRecord, VodItem } from "@/types/moseek";

export interface AdapterResult<T> {
  data: T;
  mode: "remote" | "empty";
  error: string | null;
}

export async function searchVod(
  source: SourceRecord,
  query: string,
  categoryId: string,
  page: number,
  pageSize: number,
): Promise<AdapterResult<CatalogPage>> {
  try {
    if (hasScriptArchive(source)) {
      if (!isTauriRuntime()) {
        return {
          data: emptyCatalog(source.key, page, pageSize),
          mode: "empty",
          error:
            "浏览器预览不会执行本地脚本档案，请在 Tauri 桌面应用中使用此功能。",
        };
      }
      const method: CatVodMethod = query.trim() ? "getSearch" : "getHome";
      const result = await executeScriptArchive(
        source.scriptArchiveId,
        {
          query: query.trim(),
          keyword: query.trim(),
          wd: query.trim(),
          categoryId,
          page,
          pageSize,
        },
        method,
      );
      if (!result) throw new Error("脚本档案没有返回执行结果");
      const normalized = normalizeCatVodResult(method, result.value, {
        sourceKey: source.key,
        sourceName: source.name,
        page,
        pageSize,
      });
      if (normalized.kind !== "catalog") {
        throw new Error(`${method} 返回值无法转换为影视目录`);
      }
      let catalog = normalized.value;
      try {
        const categoryResult = await executeScriptArchive(
          source.scriptArchiveId,
          { page, pageSize },
          "getCategory",
        );
        if (categoryResult) {
          const categories = normalizeCatVodResult(
            "getCategory",
            categoryResult.value,
            {
              sourceKey: source.key,
              sourceName: source.name,
            },
          );
          if (categories.kind === "categories" && categories.value.length > 0) {
            catalog = { ...catalog, categories: categories.value };
          }
        }
      } catch {
        // Some CatVod scripts do not expose getCategory; keep categories from home/search.
      }
      return { data: catalog, mode: "remote", error: null };
    }
    const remoteResult = await browseSource(
      source,
      query,
      categoryId,
      page,
      pageSize,
    );
    if (remoteResult) {
      return { data: remoteResult, mode: "remote", error: null };
    }
  } catch (error) {
    return {
      data: emptyCatalog(source.key, page, pageSize),
      mode: "remote",
      error: getErrorMessage(error, "CMS 请求失败"),
    };
  }

  return {
    data: emptyCatalog(source.key, page, pageSize),
    mode: "empty",
    error: isTauriRuntime()
      ? "CMS 请求未返回可解析数据"
      : "浏览器预览不会直接请求 CMS 数据，请在 Tauri 桌面应用中使用此功能。",
  };
}

export async function getVodDetail(
  source: SourceRecord,
  item: VodItem,
): Promise<AdapterResult<VodItem | null>> {
  try {
    if (hasScriptArchive(source)) {
      if (!isTauriRuntime()) {
        return {
          data: null,
          mode: "empty",
          error:
            "浏览器预览不会执行本地脚本档案，请在 Tauri 桌面应用中使用此功能。",
        };
      }
      const result = await executeScriptArchive(
        source.scriptArchiveId,
        { id: item.id, vodId: item.id },
        "getDetail",
      );
      if (!result) throw new Error("脚本档案没有返回执行结果");
      const normalized = normalizeCatVodResult("getDetail", result.value, {
        sourceKey: source.key,
        sourceName: source.name,
      });
      if (normalized.kind !== "detail") {
        throw new Error("getDetail 返回值无法转换为影视详情");
      }
      return { data: normalized.value, mode: "remote", error: null };
    }
    const remoteResult = await getDetail(source, item.id);
    if (remoteResult) {
      return { data: remoteResult, mode: "remote", error: null };
    }
  } catch (error) {
    return {
      data: null,
      mode: "remote",
      error: getErrorMessage(error, "详情请求失败"),
    };
  }

  return {
    data: null,
    mode: "empty",
    error: isTauriRuntime()
      ? "详情请求未返回可解析数据"
      : "浏览器预览不会直接请求 CMS 详情，请在 Tauri 桌面应用中使用此功能。",
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
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

function emptyCatalog(
  sourceKey: string,
  page: number,
  pageSize: number,
): CatalogPage {
  return {
    sourceKey,
    items: [],
    categories: [],
    page,
    pageCount: 1,
    pageSize,
    total: 0,
  };
}
