/**
 * Minimal shapes of the League client (LCU) endpoints we use. Only the fields we read are
 * typed; the client sends many more. Identity fields (names, puuids) are deliberately absent:
 * the helper never reads nor shows who the other players are.
 */

/** `assignedPosition` in champion select; '' in blind/custom games. */
export type LcuAssignedPosition = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | '';

export interface LcuChampSelectPlayer {
  cellId: number;
  /** Selected champion (hovered or locked for allies, revealed for enemies); 0 = none. */
  championId: number;
  /** Champion declared during the planning phase; 0 = none. */
  championPickIntent: number;
  assignedPosition: LcuAssignedPosition | string;
  spell1Id: number;
  spell2Id: number;
  team: number;
}

export type LcuActionType = 'ban' | 'pick' | 'ten_bans_reveal' | string;

export interface LcuChampSelectAction {
  id: number;
  actorCellId: number;
  championId: number;
  completed: boolean;
  isAllyAction: boolean;
  isInProgress: boolean;
  type: LcuActionType;
}

export type LcuChampSelectPhase =
  | 'PLANNING'
  | 'BAN_PICK'
  | 'FINALIZATION'
  | 'GAME_STARTING'
  | string;

export interface LcuChampSelectSession {
  gameId: number;
  localPlayerCellId: number;
  myTeam: LcuChampSelectPlayer[];
  theirTeam: LcuChampSelectPlayer[];
  /** Action groups, in turn order. */
  actions: LcuChampSelectAction[][];
  bans: {
    myTeamBans: number[];
    theirTeamBans: number[];
    numBans: number;
  };
  timer: {
    phase: LcuChampSelectPhase;
    adjustedTimeLeftInPhase: number;
  };
}

/** `GET /lol-champions/v1/owned-champions-minimal` entry. */
export interface LcuOwnedChampion {
  id: number;
  freeToPlay?: boolean;
  ownership?: {
    owned?: boolean;
    rental?: { rented?: boolean };
  };
}

/** `GET /lol-champion-mastery/v1/local-player/champion-mastery` entry. */
export interface LcuChampionMastery {
  championId: number;
  championLevel: number;
  championPoints: number;
}

/** `GET /lol-summoner/v1/current-summoner` (the user's own account only). */
export interface LcuCurrentSummoner {
  summonerId: number;
  gameName?: string;
  tagLine?: string;
  displayName?: string;
}

/** `GET /lol-perks/v1/pages` entry. */
export interface LcuPerkPage {
  id: number;
  name: string;
  isEditable: boolean;
  isDeletable: boolean;
  current: boolean;
  primaryStyleId: number;
  subStyleId: number;
  selectedPerkIds: number[];
}

/** `GET /lol-perks/v1/inventory`. */
export interface LcuPerkInventory {
  /** Custom page slots the account owns. */
  ownedPageCount: number;
}

/** Body of `POST /lol-perks/v1/pages` / `PUT /lol-perks/v1/pages/{id}`. */
export interface LcuPerkPageInput {
  name: string;
  primaryStyleId: number;
  subStyleId: number;
  selectedPerkIds: number[];
  current: boolean;
}

/** Body of `PATCH /lol-champ-select/v1/session/my-selection`. */
export interface LcuMySelectionPatch {
  spell1Id: number;
  spell2Id: number;
}
