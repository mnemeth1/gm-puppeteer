import type { z } from 'zod';
import type { Config } from '../config.js';
import { activateSceneTool } from './activate-scene.js';
import { addCombatantsTool } from './add-combatants.js';
import { addItemToActorTool } from './add-item-to-actor.js';
import { applyConditionTool } from './apply-condition.js';
import { assignActorOwnershipTool } from './assign-actor-ownership.js';
import { assignJournalOwnershipTool } from './assign-journal-ownership.js';
import { beginCombatTool } from './begin-combat.js';
import { calculateEncounterBudgetTool } from './calculate-encounter-budget.js';
import { createActorFromCompendiumTool } from './create-actor-from-compendium.js';
import { createJournalEntryTool } from './create-journal-entry.js';
import { createJournalPageTool } from './create-journal-page.js';
import { createScrollOrWandTool } from './create-scroll-or-wand.js';
import { deleteJournalEntryTool } from './delete-journal-entry.js';
import { deleteJournalPageTool } from './delete-journal-page.js';
import { deleteTokenTool } from './delete-token.js';
import { dnd5eAddItemToActorTool } from './dnd5e-add-item-to-actor.js';
import { dnd5eApplyConditionTool } from './dnd5e-apply-condition.js';
import { dnd5eGetActorInventoryTool } from './dnd5e-get-actor-inventory.js';
import { dnd5eGetActorStateTool } from './dnd5e-get-actor-state.js';
import { dnd5eGetAvailableConditionsTool } from './dnd5e-get-available-conditions.js';
import { dnd5eGetCreatureDetailsTool } from './dnd5e-get-creature-details.js';
import { dnd5eGetItemDetailsTool } from './dnd5e-get-item-details.js';
import { dnd5eMoveItemToContainerTool } from './dnd5e-move-item-to-container.js';
import { dnd5eRemoveConditionTool } from './dnd5e-remove-condition.js';
import { dnd5eRemoveItemFromActorTool } from './dnd5e-remove-item-from-actor.js';
import { dnd5eRequestCheckTool } from './dnd5e-request-check.js';
import { dnd5eRollCheckTool } from './dnd5e-roll-check.js';
import { dnd5eSearchCompendiumTool } from './dnd5e-search-compendium.js';
import { dnd5eSearchRulesTool } from './dnd5e-search-rules.js';
import { dnd5eTransferItemBetweenActorsTool } from './dnd5e-transfer-item-between-actors.js';
import { dnd5eUpdateItemQuantityTool } from './dnd5e-update-item-quantity.js';
import { dnd5eUpdateItemUsesTool } from './dnd5e-update-item-uses.js';
import { endCombatTool } from './end-combat.js';
import { foundryEvalTool } from './foundry-eval.js';
import { foundryScreenshotTool } from './foundry-screenshot.js';
import { getActorInventoryTool } from './get-actor-inventory.js';
import { getActorStateTool } from './get-actor-state.js';
import { getAvailableConditionsTool } from './get-available-conditions.js';
import { getChatMessagesTool } from './get-chat-messages.js';
import { getCombatStateTool } from './get-combat-state.js';
import { getCreatureDetailsTool } from './get-creature-details.js';
import { getCurrentSceneTool } from './get-current-scene.js';
import { getItemDetailsTool } from './get-item-details.js';
import { getJournalEntryTool } from './get-journal-entry.js';
import { getJournalPageTool } from './get-journal-page.js';
import { getSceneTokensTool } from './get-scene-tokens.js';
import { getTokenDetailsTool } from './get-token-details.js';
import { getWorldInfoTool } from './get-world-info.js';
import { listActorOwnershipTool } from './list-actor-ownership.js';
import { listCompendiumPacksTool } from './list-compendium-packs.js';
import { listJournalOwnershipTool } from './list-journal-ownership.js';
import { listJournalsTool } from './list-journals.js';
import { listScenesTool } from './list-scenes.js';
import { listUsersTool } from './list-users.js';
import { listWorldActorsTool } from './list-world-actors.js';
import { moveItemToContainerTool } from './move-item-to-container.js';
import { moveTokenTool } from './move-token.js';
import { placeTokenAtGridTool } from './place-token-at-grid.js';
import { placeTokenAtScreenPixelTool } from './place-token-at-screen-pixel.js';
import { postChatMessageTool } from './post-chat-message.js';
import { removeActorOwnershipTool } from './remove-actor-ownership.js';
import { removeCombatantsTool } from './remove-combatants.js';
import { removeConditionTool } from './remove-condition.js';
import { removeJournalOwnershipTool } from './remove-journal-ownership.js';
import { removeItemFromActorTool } from './remove-item-from-actor.js';
import { requestCheckTool } from './request-check.js';
import { rollCheckTool } from './roll-check.js';
import { rollDiceTool } from './roll-dice.js';
import { rollNpcsTool } from './roll-npcs.js';
import { searchCompendiumTool } from './search-compendium.js';
import { searchJournalsTool } from './search-journals.js';
import { showJournalEntryTool } from './show-journal-entry.js';
import { startCombatTool } from './start-combat.js';
import { updateJournalEntryTool } from './update-journal-entry.js';
import { updateJournalPageTool } from './update-journal-page.js';
import { setConditionValueTool } from './set-condition-value.js';
import { transferItemBetweenActorsTool } from './transfer-item-between-actors.js';
import type { ToolDefinition } from './types.js';
import { updateItemQuantityTool } from './update-item-quantity.js';
import { updateItemUsesTool } from './update-item-uses.js';
import { updateTokenTool } from './update-token.js';
import { useItemTool } from './use-item.js';
import { viewSceneTool } from './view-scene.js';

export const tools: ReadonlyArray<ToolDefinition<z.ZodTypeAny>> = [
  activateSceneTool,
  addCombatantsTool,
  addItemToActorTool,
  applyConditionTool,
  assignActorOwnershipTool,
  assignJournalOwnershipTool,
  beginCombatTool,
  calculateEncounterBudgetTool,
  createActorFromCompendiumTool,
  createJournalEntryTool,
  createJournalPageTool,
  createScrollOrWandTool,
  deleteJournalEntryTool,
  deleteJournalPageTool,
  deleteTokenTool,
  dnd5eAddItemToActorTool,
  dnd5eApplyConditionTool,
  dnd5eGetActorInventoryTool,
  dnd5eGetActorStateTool,
  dnd5eGetAvailableConditionsTool,
  dnd5eGetCreatureDetailsTool,
  dnd5eGetItemDetailsTool,
  dnd5eMoveItemToContainerTool,
  dnd5eRemoveConditionTool,
  dnd5eRemoveItemFromActorTool,
  dnd5eRequestCheckTool,
  dnd5eRollCheckTool,
  dnd5eSearchCompendiumTool,
  dnd5eSearchRulesTool,
  dnd5eTransferItemBetweenActorsTool,
  dnd5eUpdateItemQuantityTool,
  dnd5eUpdateItemUsesTool,
  endCombatTool,
  foundryEvalTool,
  foundryScreenshotTool,
  getActorInventoryTool,
  getActorStateTool,
  getAvailableConditionsTool,
  getChatMessagesTool,
  getCombatStateTool,
  getCreatureDetailsTool,
  getCurrentSceneTool,
  getItemDetailsTool,
  getJournalEntryTool,
  getJournalPageTool,
  getSceneTokensTool,
  getTokenDetailsTool,
  getWorldInfoTool,
  listActorOwnershipTool,
  listCompendiumPacksTool,
  listJournalOwnershipTool,
  listJournalsTool,
  listScenesTool,
  listUsersTool,
  listWorldActorsTool,
  moveItemToContainerTool,
  moveTokenTool,
  placeTokenAtGridTool,
  placeTokenAtScreenPixelTool,
  postChatMessageTool,
  removeActorOwnershipTool,
  removeCombatantsTool,
  removeConditionTool,
  removeItemFromActorTool,
  removeJournalOwnershipTool,
  requestCheckTool,
  rollCheckTool,
  rollDiceTool,
  rollNpcsTool,
  searchCompendiumTool,
  searchJournalsTool,
  setConditionValueTool,
  showJournalEntryTool,
  startCombatTool,
  transferItemBetweenActorsTool,
  updateItemQuantityTool,
  updateItemUsesTool,
  updateJournalEntryTool,
  updateJournalPageTool,
  updateTokenTool,
  useItemTool,
  viewSceneTool,
];

/**
 * The tool registry actually exposed to MCP clients, after applying
 * config gating. `foundry_eval` runs arbitrary JS against the live
 * Foundry GM client; it is registered only when `config.allowEval` is
 * true (default false — see `ALLOW_EVAL` in config). All other tools are
 * always present.
 */
export function selectTools(config: Config): ReadonlyArray<ToolDefinition<z.ZodTypeAny>> {
  if (config.allowEval) return tools;
  return tools.filter((t) => t !== foundryEvalTool);
}
