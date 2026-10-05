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

/**
 * The library is whatever the listing said it was.
 *
 * There is deliberately no cover enrichment here. A source whose listing carries no covers shows its
 * own "暂无海报" state, because the only way to get covers for such a source is one detail request
 * *per work* — and that is a behaviour the user rejected on principle: a page of 20 cards becomes 20
 * requests against a single host, which invites rate limiting, and the result is nondeterministic in
 * a way a library view must not be. Measured on the real `采集集合` deployment the covers really do
 * exist behind `ac=detail` (0/20 in the listing, 20/20 there), and the fan-out was 3.9× faster than
 * asking for the page in one request (6 762 ms against 26 207 ms) — but "this source published no
 * covers with its listing" is a legitimate answer, and paying a request storm to overrule it is not
 * worth it. The work's own page still fetches its detail record the moment it is opened, which is
 * where a cover is actually needed.
 */

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
