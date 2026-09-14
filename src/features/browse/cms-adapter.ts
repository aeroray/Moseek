import { getSourceDetail, isTauriRuntime, searchSource } from "@/lib/tauri";
import { getMockCatalog, getMockDetail } from "@/lib/mock-vod-data";
import type { CatalogPage, SourceRecord, VodItem } from "@/types/moseek";

export interface AdapterResult<T> {
  data: T;
  mode: "remote" | "demo";
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
    const remoteResult = await searchSource(
      source.key,
      source.api,
      query,
      categoryId,
      page,
      pageSize,
    );
    if (remoteResult) {
      return { data: remoteResult, mode: "remote", error: null };
    }
  } catch (error) {
    if (isTauriRuntime()) {
      return {
        data: emptyCatalog(source.key, page, pageSize),
        mode: "remote",
        error: error instanceof Error ? error.message : "CMS 请求失败",
      };
    }
  }

  return {
    data: getMockCatalog(source.key, query, categoryId, page, pageSize),
    mode: "demo",
    error: null,
  };
}

export async function getVodDetail(
  source: SourceRecord,
  item: VodItem,
): Promise<AdapterResult<VodItem | null>> {
  try {
    const remoteResult = await getSourceDetail(source.key, source.api, item.id);
    if (remoteResult) {
      return { data: remoteResult, mode: "remote", error: null };
    }
  } catch (error) {
    if (isTauriRuntime()) {
      return {
        data: item,
        mode: "remote",
        error: error instanceof Error ? error.message : "详情请求失败",
      };
    }
  }

  return { data: getMockDetail(item.id) ?? item, mode: "demo", error: null };
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
