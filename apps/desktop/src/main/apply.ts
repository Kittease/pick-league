/** Writes a build's runes + summoner spells to the League client (the only LCU writes). */

import type { BuildResponse } from '@pick-league/shared';
import { planRunePageWrite, RUNE_PAGE_NAME, runePageInput } from '../core/rune-page.ts';
import { FLASH_SPELL_ID, spellsPatch } from '../core/spells.ts';
import type { LcuApi } from './lcu/api.ts';

export interface ApplyResult {
  state: 'done' | 'warning' | 'error';
  messages: string[];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function applyBuild(
  api: LcuApi,
  build: BuildResponse,
  currentSpells: [number, number],
): Promise<ApplyResult> {
  const messages: string[] = [];
  let state: ApplyResult['state'] = 'done';

  // Runes
  try {
    const page = runePageInput(build.runes);
    const plan = planRunePageWrite(await api.getPerkPages(), await api.getPerkInventory());
    if (plan.kind === 'no_slot') {
      state = 'warning';
      messages.push(plan.message);
    } else if (plan.kind === 'replace') {
      await api.replacePerkPage(plan.pageId, page);
      await api.setCurrentPerkPage(plan.pageId);
      messages.push(`Runes written to your "${RUNE_PAGE_NAME}" page`);
    } else {
      const created = await api.createPerkPage(page);
      if (created?.id) await api.setCurrentPerkPage(created.id);
      messages.push(`Runes saved as a new "${RUNE_PAGE_NAME}" page`);
    }
  } catch (e) {
    state = 'error';
    messages.push(`Runes not applied: ${errorText(e)}`);
  }

  // Summoner spells
  try {
    const patch = spellsPatch(build.summonerSpells.spellIds, currentSpells);
    if (!patch) {
      messages.push('Summoner spells already set');
    } else {
      await api.patchMySelection(patch);
      const flashKey =
        patch.spell1Id === FLASH_SPELL_ID ? 'D' : patch.spell2Id === FLASH_SPELL_ID ? 'F' : null;
      messages.push(`Summoner spells set${flashKey ? ` (Flash on ${flashKey})` : ''}`);
    }
  } catch (e) {
    state = 'error';
    messages.push(`Summoner spells not applied: ${errorText(e)}`);
  }

  return { state, messages };
}
