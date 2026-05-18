# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Nothing yet._

## [1.0.1] - 2026-05-18

### Changed

- Prerequisites now advise stating the game system in the world
  description so the MCP client picks the right tool suite.

## [1.0.0] - 2026-05-18

First production release. GM-Puppeteer is an MCP server that drives a
headless Puppeteer-managed Chromium logged into Foundry VTT v14 as a
Gamemaster, exposing typed tools over MCP/stdio.

### Added

- **Core suite (system-agnostic).** Browser/session management with
  local and Forge-hosted login flows; `foundry_eval` (gated by
  `ALLOW_EVAL`) and `foundry_screenshot`; world, scene, actor, and user
  introspection; token placement, movement, and inspection; the combat
  tracker (`start_combat`, `begin_combat`, `end_combat`, combatant
  add/remove, `get_combat_state`, `roll_npcs`); chat and dice
  (`post_chat_message`, `get_chat_messages`, `roll_dice`); actor and
  journal ownership tools; and the full journal suite, including the
  journal-folder family (create / update / delete / list).
- **Pathfinder 2e suite.** 20 system-coupled `pf2e_` tools: creature,
  actor, and item introspection; inventory and item mutation; condition
  management; check rolling; compendium search; scroll/wand creation;
  encounter-budget math; and the item-use pipeline.
- **D&D 5e suite.** A 20-tool `dnd5e_` catalog at full parity with the
  PF2e suite, built against D&D 5e 5.3.3, plus `dnd5e_search_rules` for
  the rules glossary.
- **Distribution.** A self-contained Windows installer bundling its own
  Node runtime and Chromium, built by tag-driven CI.

### Changed

- The PF2e tool family now follows the same `pf2e-` file and symbol
  naming convention as the D&D 5e family, so the two are mirror images.
- Tool error classification is unified behind a single classifier.
  Failures where Foundry rejected an otherwise-valid request now report
  `EVAL_FAILED` (or `FOUNDRY_NOT_READY` for subsystem-not-ready faults)
  instead of `INVALID_INPUT`, and every tool error surfaces its domain
  code in `details.reason`.

[1.0.0]: https://github.com/mnemeth1/gm-puppeteer/releases/tag/v1.0.0
