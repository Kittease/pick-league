'use server';

import {
  API_ROUTES,
  type BuildResponse,
  buildRequestSchema,
  type DraftEvaluationResponse,
  draftRequestSchema,
  type HealthResponse,
  type PicksResponse,
  picksRequestSchema,
  type StatsStatusResponse,
  type TierListChampionResponse,
  type TierListResponse,
  tierListChampionQuerySchema,
  tierListQuerySchema,
} from '@pick-league/shared';
import type { ApiResult } from '@pick-league/ui/lib/types';
import type { z } from 'zod';
import { apiPost } from '@/lib/api';
import { badRequest } from '@/lib/api-result';
import * as queries from '@/lib/queries';

/**
 * Server Actions behind the shared views' `PickLeagueData` (see `components/data.tsx`). They are
 * public endpoints: every argument is validated with the contract's schemas before the API is
 * called. Answers are plain `ApiResult`s.
 */

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; result: ApiResult<never> } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    result: badRequest(
      `Invalid request${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`,
    ),
  };
}

const filtersOf = (filters: unknown) =>
  typeof filters === 'object' && filters !== null ? filters : {};

export async function getTierList(
  role: unknown,
  filters?: unknown,
): Promise<ApiResult<TierListResponse>> {
  const query = parse(tierListQuerySchema, { ...filtersOf(filters), role, patch: 'latest' });
  return query.ok ? queries.getTierList(query.data) : query.result;
}

export async function getTierListChampion(
  role: unknown,
  championId: unknown,
  filters?: unknown,
): Promise<ApiResult<TierListChampionResponse>> {
  const query = parse(tierListChampionQuerySchema, {
    ...filtersOf(filters),
    role,
    championId,
    patch: 'latest',
  });
  return query.ok ? queries.getTierListChampion(query.data) : query.result;
}

export async function getGenericBuild(
  championId: unknown,
  role: unknown,
): Promise<ApiResult<BuildResponse>> {
  const body = parse(buildRequestSchema, { championId, role, allies: [], enemies: [] });
  return body.ok ? apiPost(API_ROUTES.build, body.data) : body.result;
}

export async function draftPicks(request: unknown): Promise<ApiResult<PicksResponse>> {
  const body = parse(picksRequestSchema, request);
  return body.ok ? apiPost(API_ROUTES.picks, body.data) : body.result;
}

export async function draftBuild(request: unknown): Promise<ApiResult<BuildResponse>> {
  const body = parse(buildRequestSchema, request);
  return body.ok ? apiPost(API_ROUTES.build, body.data) : body.result;
}

export async function evaluateDraft(request: unknown): Promise<ApiResult<DraftEvaluationResponse>> {
  const body = parse(draftRequestSchema, request);
  return body.ok ? apiPost(API_ROUTES.draft, body.data) : body.result;
}

/** What the header shows (API patch + matches, stats freshness), polled by the page. */
export interface ServerStatus {
  health: HealthResponse | null;
  stats: StatsStatusResponse | null;
}

export async function getServerStatus(): Promise<ServerStatus> {
  const [health, stats] = await Promise.all([queries.getHealth(), queries.getStatsStatus()]);
  return { health: health.ok ? health.data : null, stats: stats.ok ? stats.data : null };
}
