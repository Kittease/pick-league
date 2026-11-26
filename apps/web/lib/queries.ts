import 'server-only';
import {
  API_ROUTES,
  type HealthResponse,
  PATCH_CHANGES_INDEX_ROUTE,
  PATCH_NOTES_ROUTE,
  type PatchChangesIndexResponse,
  type PatchNotesQuery,
  type PatchNotesResponse,
  type StaticDataResponse,
  type StatsStatusResponse,
  TIER_LIST_CHAMPION_ROUTE,
  TIER_LIST_ROUTE,
  type TierListChampionQuery,
  type TierListChampionResponse,
  type TierListQuery,
  type TierListResponse,
} from '@pick-league/shared';
import type { ApiResult } from '@pick-league/ui/lib/types';
import { apiGet } from './api.ts';
import { REVALIDATE, TAGS } from './cache.ts';

/** The API's GET routes, with their cache lifetimes (see `REVALIDATE`). */

export function getHealth(): Promise<ApiResult<HealthResponse>> {
  return apiGet(API_ROUTES.health, { revalidate: REVALIDATE.health, tags: [TAGS.health] });
}

export function getStatsStatus(): Promise<ApiResult<StatsStatusResponse>> {
  return apiGet(API_ROUTES.statsStatus, {
    revalidate: REVALIDATE.statsStatus,
    tags: [TAGS.statsStatus],
  });
}

export function getStaticData(patch = 'latest'): Promise<ApiResult<StaticDataResponse>> {
  return apiGet(API_ROUTES.static(patch), { revalidate: REVALIDATE.static, tags: [TAGS.static] });
}

export function getTierList(query: TierListQuery): Promise<ApiResult<TierListResponse>> {
  const { role, patch, platform, rank } = query;
  return apiGet(`${TIER_LIST_ROUTE}?${new URLSearchParams({ role, patch, platform, rank })}`, {
    revalidate: REVALIDATE.tierList,
    tags: [TAGS.tierList],
  });
}

export function getTierListChampion(
  query: TierListChampionQuery,
): Promise<ApiResult<TierListChampionResponse>> {
  const { role, patch, platform, rank, championId } = query;
  const params = new URLSearchParams({
    role,
    championId: String(championId),
    patch,
    platform,
    rank,
  });
  return apiGet(`${TIER_LIST_CHAMPION_ROUTE}?${params}`, {
    revalidate: REVALIDATE.tierListChampion,
    tags: [TAGS.tierList],
  });
}

export function getPatchNotesIndex(): Promise<ApiResult<PatchChangesIndexResponse>> {
  return apiGet(PATCH_CHANGES_INDEX_ROUTE, {
    revalidate: REVALIDATE.patchNotes,
    tags: [TAGS.patchNotes],
  });
}

export function getPatchNotes(query: PatchNotesQuery): Promise<ApiResult<PatchNotesResponse>> {
  const { patch, build } = query;
  const params = new URLSearchParams(build ? { patch, build } : { patch });
  return apiGet(`${PATCH_NOTES_ROUTE}?${params}`, {
    revalidate: REVALIDATE.patchNotes,
    tags: [TAGS.patchNotes],
  });
}
