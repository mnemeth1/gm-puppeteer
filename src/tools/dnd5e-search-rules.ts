import { z } from 'zod';
import { toolErrorFromEvaluator } from '../errors.js';
import {
  dnd5eSearchRulesBody,
  type Dnd5eSearchRulesResult,
} from '../evaluators/dnd5e-search-rules.js';
import { jsonText, type ToolDefinition } from './types.js';

const Dnd5eSearchRulesInput = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        'Substring to search for (case-insensitive). Plain text — no regex, no globs. ' +
          'Matched against compendium journal page names and page bodies (HTML stripped ' +
          'to prose before matching).',
      ),
    packs: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Restrict to specific JournalEntry pack collection ids (e.g. ["dnd5e.content24"]). ' +
          'Default: every compendium JournalEntry pack. The same rule recurs across the SRD, ' +
          '2024, and module packs — use this to scope to one edition.',
      ),
    pageTypes: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Restrict to specific JournalEntryPage types. Default: all text-bearing types ' +
          '(text, rule, spells, subclass, class). Pass ["rule"] to search only the rules ' +
          'glossary (conditions, areas of effect, and other glossary entries).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of hits to return. Default 20. Hard ceiling 100.'),
    snippetLength: z
      .number()
      .int()
      .min(40)
      .max(2000)
      .optional()
      .describe(
        'Approximate match-window snippet length in characters. Default 240. The full ' +
          'page prose is also returned separately as `pageText` (capped at 2000 chars).',
      ),
  })
  .strict();

export const dnd5eSearchRulesTool: ToolDefinition<typeof Dnd5eSearchRulesInput> = {
  name: 'dnd5e_search_rules',
  description:
    'Page-level full-text search across D&D 5e compendium JournalEntry packs — the rules ' +
    'glossary, lore, and reference content. This is the page-level companion to ' +
    'dnd5e_search_compendium: rules text in 5e is page-structured (a condition like ' +
    '"Grappled" is a JournalEntryPage inside an "Appendix C: Rules Glossary" entry, not an ' +
    'entry of its own), and dnd5e_search_compendium only matches entry names. Matches page ' +
    'names and page bodies; returns ranked hits — page-name matches first, then body ' +
    'matches — each carrying a context `snippet`, the full page prose (`pageText`, capped ' +
    'at 2000 chars), and the `pageUuid` for follow-up. Optional `packs` (scope by ' +
    'edition) and `pageTypes` (e.g. ["rule"] for glossary-only) filters narrow the scan. ' +
    'Searches every compendium JournalEntry pack by default. NOT for world journals (use ' +
    'search_journals) and NOT for stat blocks / items / spells as documents (use ' +
    'dnd5e_search_compendium).',
  inputSchema: Dnd5eSearchRulesInput,
  async handler(input, ctx) {
    const { page } = await ctx.browser.ensureStarted();
    const result = (await page.evaluate(dnd5eSearchRulesBody, {
      query: input.query,
      packs: input.packs,
      pageTypes: input.pageTypes,
      limit: input.limit,
      snippetLength: input.snippetLength,
    })) as Dnd5eSearchRulesResult;
    if (!result.ok) {
      throw toolErrorFromEvaluator(result.error);
    }
    return [jsonText(result)];
  },
};
