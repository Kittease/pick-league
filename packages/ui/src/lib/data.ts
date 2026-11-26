import type {
  BuildRequestInput,
  BuildResponse,
  DraftEvaluationResponse,
  DraftRequestInput,
  PatchChangesIndexResponse,
  PatchNotesResponse,
  PicksRequestInput,
  PicksResponse,
  Position,
  TierListChampionResponse,
  TierListFilters,
  TierListResponse,
} from '@pick-league/shared';
import type { ApiResult } from './types';

/**
 * The API calls the shared views make, provided by the host app (`PickLeagueDataProvider`): the
 * desktop's IPC bridge, or a web app's Server Actions. Arguments and results are plain
 * serializable data; failures come back as `{ ok: false }`, never as thrown errors.
 */
export interface PickLeagueData {
  /** Tier list of a role (latest patch), filtered by server and rank (default: all, Diamond+). */
  getTierList(role: Position, filters?: TierListFilters): Promise<ApiResult<TierListResponse>>;
  /** Matchups, duos and synergies of a tier list champion (fetched when it is selected). */
  getTierListChampion(
    role: Position,
    championId: number,
    filters?: TierListFilters,
  ): Promise<ApiResult<TierListChampionResponse>>;
  /** Build of a champion in a role with no allies/enemies (tier list "View build"). */
  getGenericBuild(championId: number, role: Position): Promise<ApiResult<BuildResponse>>;
  /** Draft planner: pick recommendations for a simulated draft. */
  draftPicks(request: PicksRequestInput): Promise<ApiResult<PicksResponse>>;
  /** Draft planner: build of a drafted champion against the simulated teams. */
  draftBuild(request: BuildRequestInput): Promise<ApiResult<BuildResponse>>;
  /** Win probability and damage split of a draft. */
  evaluateDraft(request: DraftRequestInput): Promise<ApiResult<DraftEvaluationResponse>>;
  /** Patch notes: the patches with changes and their hotfixes (the selector). */
  getPatchNotesIndex(): Promise<ApiResult<PatchChangesIndexResponse>>;
  /** Patch notes of a patch ('latest') or of one of its builds (a hotfix). */
  getPatchNotes(patch: string, build?: string): Promise<ApiResult<PatchNotesResponse>>;
}
