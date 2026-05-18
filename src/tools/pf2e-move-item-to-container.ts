import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  pf2eMoveItemToContainerBody,
  type Pf2eMoveItemToContainerResult,
} from '../evaluators/pf2e-move-item-to-container.js';
import { jsonText, type ToolDefinition } from './types.js';

/**
 * Schema for `pf2e_move_item_to_container`. Single-shape input: actorId,
 * itemId, containerId (nullable — null = root inventory), merge
 * (defaults true).
 *
 * No numeric inputs — the strict-int / no-coerce convention from
 * `pf2e_update_item_quantity` is intentionally absent here because the
 * surface has no scalar parameters.
 *
 * Out-of-scope inputs (do NOT add):
 *   - `quantity` — partial-stack moves are split-and-move; compose from
 *     `pf2e_update_item_quantity` (decrement source) + `pf2e_add_item_to_actor`
 *     (create destination) until a `split_item` tool exists.
 *   - `identified` — identification changes are a separate concern;
 *     the move preserves the source's identification status.
 *   - `destinationActorId` — cross-actor transfer has different
 *     semantics (rune carryover, identification rules, merge identity
 *     across actors) and belongs in a future
 *     `pf2e_transfer_item_between_actors` tool.
 */
const Pf2eMoveItemToContainerInput = z
  .object({
    actorId: z
      .string()
      .min(1)
      .describe(
        'World actor id (matches the actorId returned by pf2e_get_actor_inventory). The actor whose ' +
          'item will be relocated.',
      ),
    itemId: z
      .string()
      .min(1)
      .describe(
        'Id of the item to move (the `id` field returned by pf2e_get_actor_inventory). NOT a ' +
          'compendium UUID — the item must already be embedded on this actor. Must be a physical ' +
          'item type (weapon, armor, shield, consumable, equipment, backpack, treasure, ammo).',
      ),
    containerId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Destination container id (an item of type "backpack" on the same actor), OR null to ' +
          "move the item to the actor's top-level inventory. Foundry does not enforce that this " +
          'points at an actual container; the tool rejects non-backpack ids up front.',
      ),
    merge: z
      .boolean()
      .optional()
      .describe(
        'Stack-merge behavior. Default true. When true, if the destination contains a sibling ' +
          'with the same compendium source AND same identification status, the source item folds ' +
          'into the sibling (sibling quantity += source quantity, source deleted). Set false to ' +
          'always perform a plain move even when a merge candidate exists. Mismatch on ' +
          'compendiumSource / containerId / identification produces a plain move regardless.',
      ),
  })
  .strict();

export const pf2eMoveItemToContainerTool: ToolDefinition<typeof Pf2eMoveItemToContainerInput> = {
  name: 'pf2e_move_item_to_container',
  description:
    'Move a physical item between containers on the same actor, or to/from root inventory. ' +
    'Sibling to pf2e_add_item_to_actor (compendium → actor) and pf2e_update_item_quantity (set quantity) — ' +
    'this is the relational-field-mutation member of the inventory cluster, changing only ' +
    '`system.containerId`. ' +
    'Returns either {operation: "moved", item: {id, name, type, quantity, containerIdBefore, ' +
    'containerIdAfter}} for a plain relocation (containerIdBefore === containerIdAfter signals a ' +
    'clean same-destination no-op, NOT an error), or {operation: "merged", mergedInto: {id, name, ' +
    'type, qtyBefore, qtyAfter}} when the destination already had a matching sibling and merge ' +
    'folded the source into it (the source item id is no longer valid; refresh via ' +
    'pf2e_get_actor_inventory). ' +
    'Merge identity matches pf2e_add_item_to_actor: same compendium source + same destination ' +
    'containerId + same identification status. Pass merge: false to opt out. ' +
    'Moving a container with contents leaves the contents inside it (their containerId references ' +
    'are unaffected — Foundry handles this implicitly). ' +
    'Physical inventory only — feats, classes, spells, etc. are rejected (they have no ' +
    '`system.containerId` field). Cycle-prevention is enforced by the tool: moving an item ' +
    'into itself, or into one of its own descendants, is rejected with CYCLE_DETECTED. ' +
    'Out of scope (use other tools / wait for dedicated ones): partial-stack moves (compose from ' +
    'pf2e_update_item_quantity + pf2e_add_item_to_actor), cross-actor transfer, identification changes, ' +
    'sort-order reorder.',
  inputSchema: Pf2eMoveItemToContainerInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const args = {
      actorId: input.actorId,
      itemId: input.itemId,
      containerId: input.containerId,
      merge: input.merge ?? true,
    };
    const result = (await page.evaluate(
      pf2eMoveItemToContainerBody,
      args,
    )) as Pf2eMoveItemToContainerResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    if (result.operation === 'moved') {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          itemId: result.item.id,
          itemName: result.item.name,
          containerIdBefore: result.item.containerIdBefore,
          containerIdAfter: result.item.containerIdAfter,
        },
        'pf2e_move_item_to_container',
      );
    } else {
      ctx.log.info(
        {
          actorId: result.actor.id,
          operation: result.operation,
          mergedIntoId: result.mergedInto.id,
          mergedIntoName: result.mergedInto.name,
          qtyBefore: result.mergedInto.qtyBefore,
          qtyAfter: result.mergedInto.qtyAfter,
        },
        'pf2e_move_item_to_container',
      );
    }
    return [jsonText(result)];
  },
};
