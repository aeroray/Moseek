import { browseSource, getDetail, isTauriRuntime } from "@/lib/tauri";
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
