import type { z } from 'zod';
import type { Config } from '../config.js';
import { activateSceneTool } from './activate-scene.js';
import { addCombatantsTool } from './add-combatants.js';
import { assignActorOwnershipTool } from './assign-actor-ownership.js';
import { assignJournalOwnershipTool } from './assign-journal-ownership.js';
import { beginCombatTool } from './begin-combat.js';
import { createActorFromCompendiumTool } from './create-actor-from-compendium.js';
import { createJournalEntryTool } from './create-journal-entry.js';
import { createJournalFolderTool } from './create-journal-folder.js';
import { createJournalPageTool } from './create-journal-page.js';
import { deleteJournalEntryTool } from './delete-journal-entry.js';
import { deleteJournalFolderTool } from './delete-journal-folder.js';
import { deleteJournalPageTool } from './delete-journal-page.js';
import { deleteTokenTool } from './delete-token.js';
import { dnd5eAddItemToActorTool } from './dnd5e-add-item-to-actor.js';
import { dnd5eApplyConditionTool } from './dnd5e-apply-condition.js';
import { dnd5eCalculateEncounterBudgetTool } from './dnd5e-calculate-encounter-budget.js';
import { dnd5eCreateScrollTool } from './dnd5e-create-scroll.js';
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
import { dnd5eUseItemTool } from './dnd5e-use-item.js';
import { endCombatTool } from './end-combat.js';
import { foundryEvalTool } from './foundry-eval.js';
import { foundryScreenshotTool } from './foundry-screenshot.js';
import { getChatMessagesTool } from './get-chat-messages.js';
import { getCombatStateTool } from './get-combat-state.js';
import { getCurrentSceneTool } from './get-current-scene.js';
import { getJournalEntryTool } from './get-journal-entry.js';
import { getJournalPageTool } from './get-journal-page.js';
import { getSceneTokensTool } from './get-scene-tokens.js';
import { getTokenDetailsTool } from './get-token-details.js';
import { getWorldInfoTool } from './get-world-info.js';
import { listActorOwnershipTool } from './list-actor-ownership.js';
import { listCompendiumPacksTool } from './list-compendium-packs.js';
import { listJournalFoldersTool } from './list-journal-folders.js';
import { listJournalOwnershipTool } from './list-journal-ownership.js';
import { listJournalsTool } from './list-journals.js';
import { listScenesTool } from './list-scenes.js';
import { listUsersTool } from './list-users.js';
import { listWorldActorsTool } from './list-world-actors.js';
import { moveTokenTool } from './move-token.js';
import { pf2eAddItemToActorTool } from './pf2e-add-item-to-actor.js';
import { pf2eApplyConditionTool } from './pf2e-apply-condition.js';
import { pf2eCalculateEncounterBudgetTool } from './pf2e-calculate-encounter-budget.js';
import { pf2eCreateScrollOrWandTool } from './pf2e-create-scroll-or-wand.js';
import { pf2eGetActorInventoryTool } from './pf2e-get-actor-inventory.js';
import { pf2eGetActorStateTool } from './pf2e-get-actor-state.js';
import { pf2eGetAvailableConditionsTool } from './pf2e-get-available-conditions.js';
import { pf2eGetCreatureDetailsTool } from './pf2e-get-creature-details.js';
import { pf2eGetItemDetailsTool } from './pf2e-get-item-details.js';
import { pf2eMoveItemToContainerTool } from './pf2e-move-item-to-container.js';
import { pf2eRemoveConditionTool } from './pf2e-remove-condition.js';
import { pf2eRemoveItemFromActorTool } from './pf2e-remove-item-from-actor.js';
import { pf2eRequestCheckTool } from './pf2e-request-check.js';
import { pf2eRollCheckTool } from './pf2e-roll-check.js';
import { pf2eSearchCompendiumTool } from './pf2e-search-compendium.js';
import { pf2eSetConditionValueTool } from './pf2e-set-condition-value.js';
import { pf2eTransferItemBetweenActorsTool } from './pf2e-transfer-item-between-actors.js';
import { pf2eUpdateItemQuantityTool } from './pf2e-update-item-quantity.js';
import { pf2eUpdateItemUsesTool } from './pf2e-update-item-uses.js';
import { pf2eUseItemTool } from './pf2e-use-item.js';
import { placeTokenAtGridTool } from './place-token-at-grid.js';
import { placeTokenAtScreenPixelTool } from './place-token-at-screen-pixel.js';
import { postChatMessageTool } from './post-chat-message.js';
import { removeActorOwnershipTool } from './remove-actor-ownership.js';
import { removeCombatantsTool } from './remove-combatants.js';
import { removeJournalOwnershipTool } from './remove-journal-ownership.js';
import { rollDiceTool } from './roll-dice.js';
import { rollNpcsTool } from './roll-npcs.js';
import { searchJournalsTool } from './search-journals.js';
import { showJournalEntryTool } from './show-journal-entry.js';
import { startCombatTool } from './start-combat.js';
import type { ToolDefinition } from './types.js';
import { updateJournalEntryTool } from './update-journal-entry.js';
import { updateJournalFolderTool } from './update-journal-folder.js';
import { updateJournalPageTool } from './update-journal-page.js';
import { updateTokenTool } from './update-token.js';
import { viewSceneTool } from './view-scene.js';

export const tools: ReadonlyArray<ToolDefinition<z.ZodTypeAny>> = [
  activateSceneTool,
  addCombatantsTool,
  assignActorOwnershipTool,
  assignJournalOwnershipTool,
  beginCombatTool,
  createActorFromCompendiumTool,
  createJournalEntryTool,
  createJournalFolderTool,
  createJournalPageTool,
  deleteJournalEntryTool,
  deleteJournalFolderTool,
  deleteJournalPageTool,
  deleteTokenTool,
  dnd5eAddItemToActorTool,
  dnd5eApplyConditionTool,
  dnd5eCalculateEncounterBudgetTool,
  dnd5eCreateScrollTool,
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
  dnd5eUseItemTool,
  endCombatTool,
  foundryEvalTool,
  foundryScreenshotTool,
  getChatMessagesTool,
  getCombatStateTool,
  getCurrentSceneTool,
  getJournalEntryTool,
  getJournalPageTool,
  getSceneTokensTool,
  getTokenDetailsTool,
  getWorldInfoTool,
  listActorOwnershipTool,
  listCompendiumPacksTool,
  listJournalFoldersTool,
  listJournalOwnershipTool,
  listJournalsTool,
  listScenesTool,
  listUsersTool,
  listWorldActorsTool,
  moveTokenTool,
  pf2eAddItemToActorTool,
  pf2eApplyConditionTool,
  pf2eCalculateEncounterBudgetTool,
  pf2eCreateScrollOrWandTool,
  pf2eGetActorInventoryTool,
  pf2eGetActorStateTool,
  pf2eGetAvailableConditionsTool,
  pf2eGetCreatureDetailsTool,
  pf2eGetItemDetailsTool,
  pf2eMoveItemToContainerTool,
  pf2eRemoveConditionTool,
  pf2eRemoveItemFromActorTool,
  pf2eRequestCheckTool,
  pf2eRollCheckTool,
  pf2eSearchCompendiumTool,
  pf2eSetConditionValueTool,
  pf2eTransferItemBetweenActorsTool,
  pf2eUpdateItemQuantityTool,
  pf2eUpdateItemUsesTool,
  pf2eUseItemTool,
  placeTokenAtGridTool,
  placeTokenAtScreenPixelTool,
  postChatMessageTool,
  removeActorOwnershipTool,
  removeCombatantsTool,
  removeJournalOwnershipTool,
  rollDiceTool,
  rollNpcsTool,
  searchJournalsTool,
  showJournalEntryTool,
  startCombatTool,
  updateJournalEntryTool,
  updateJournalFolderTool,
  updateJournalPageTool,
  updateTokenTool,
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
