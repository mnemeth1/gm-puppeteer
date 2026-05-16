/**
 * MCP resources — reference documents the server exposes to connecting
 * AI clients alongside its tools. Unlike `CLAUDE.md` (which steers only
 * our own development setup), resources travel with the MCP: any client
 * that surfaces resources picks this guidance up with no per-client
 * configuration.
 *
 * Resources here are static text. If a resource ever needs to reflect
 * live world state, give it a handler instead of a literal `text`.
 */

export interface ResourceDefinition {
  /** Stable resource URI (the key clients pass to read it). */
  readonly uri: string;
  /** Short human-facing label. */
  readonly name: string;
  /** One-line summary shown in resource listings. */
  readonly description: string;
  readonly mimeType: string;
  /** Resource body, served verbatim on read. */
  readonly text: string;
}

const SCOPE_AND_RULES_REFERENCE = `# GM-Puppeteer: scope and rules reference

GM-Puppeteer is an MCP server that operates a live Foundry VTT v14 world
running the Pathfinder 2e system. Its tools read and mutate **world
state** — the concrete objects in a running game.

## What this MCP covers

- **Scenes** — list, inspect, switch the GM view, activate for players.
- **Tokens** — place, move, update, delete tokens on a scene; capture
  screenshots of the canvas.
- **Actors** — enumerate world actors, import them from compendia, read
  combat-relevant state and inventory, manage ownership.
- **Items** — grant, remove, move, transfer, and inspect physical items;
  use consumables; generate spell scrolls and wands.
- **Conditions** — apply, remove, and set valued PF2e conditions.
- **Journals** — create, edit, search, and show journal entries and
  pages; manage journal ownership.
- **Compendium search** — find *world content* to bring into the game:
  NPC and hazard stat blocks, equipment items, monsters, roll tables.
- **Encounter math** — PF2e Gamemastery Guide XP budget calculations.

## What this MCP does NOT cover — and where to look instead

**PF2e rules text is out of scope.** This MCP does not return the
canonical text of spells, feats, actions, conditions, traits,
ancestries, classes, archetypes, or equipment rules. \`search_compendium\`
returns Foundry's *parsed* documents — world content for gameplay, not a
clean rules reference.

For rules text, fetch from **Archives of Nethys** (https://2e.aonprd.com/),
the canonical and comprehensive PF2e reference, using your own web-fetch
capability. AoN pages are organized by category:

- Actions — \`https://2e.aonprd.com/Actions.aspx?ID=<n>\`
- Spells — \`https://2e.aonprd.com/Spells.aspx?ID=<n>\`
- Feats — \`https://2e.aonprd.com/Feats.aspx?ID=<n>\`
- Conditions — \`https://2e.aonprd.com/Conditions.aspx?ID=<n>\`
- Traits — \`https://2e.aonprd.com/Traits.aspx?ID=<n>\`
- Equipment — \`https://2e.aonprd.com/Equipment.aspx?ID=<n>\`

AoN URLs are keyed by numeric ID, not by name. To reach a specific rule,
resolve the name to a URL with AoN's search
(\`https://2e.aonprd.com/Search.aspx?q=<query>\`) or a general web search,
then fetch the page. Apply standard copyright handling: paraphrase, no
extended quotes.

## Compendium vs. rules — the dividing line

Use \`search_compendium\` for things you place into or grant within the
game: a goblin stat block to drop on a scene, a longsword to add to an
actor, a roll table to consult. Use Archives of Nethys for the rules a
player or GM reads to understand how something works. A creature's stat
block is world content; the Frightened condition's full rules text is
reference material.

## Operating posture

This MCP is the deputy to a human Game Master, not the GM. It does the
tedious work a VTT UI is slow at — searching massive compendia, editing
inventories, applying conditions in bulk, managing journals. Narration,
calling for rolls, managing initiative, and moving player tokens remain
the human GM's job.
`;

const scopeAndRulesReference: ResourceDefinition = {
  uri: 'gm-puppeteer://reference/scope',
  name: 'Scope and rules reference',
  description:
    "What this MCP covers, what it deliberately doesn't (PF2e rules text), and where to look instead (Archives of Nethys).",
  mimeType: 'text/markdown',
  text: SCOPE_AND_RULES_REFERENCE,
};

export const resources: ReadonlyArray<ResourceDefinition> = [scopeAndRulesReference];
