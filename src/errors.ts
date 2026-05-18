export type ToolErrorCode =
  | 'BROWSER_NOT_READY'
  | 'FOUNDRY_NOT_READY'
  | 'EVAL_FAILED'
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ToolErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * The error branch every evaluator returns on `{ ok: false }`. `code` is
 * either a domain code (e.g. `SCENE_NOT_FOUND`, `CREATE_FAILED`) or the
 * literal `'INVALID_INPUT'`; in the latter case the domain code — when
 * there is one — lives in `details.reason`. The two shapes are historical;
 * `toolErrorFromEvaluator` reads whichever the evaluator used.
 */
export interface EvaluatorError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Domain codes that mean "the request was well-formed but Foundry or the
 * game system rejected the operation" — a runtime failure, not bad input.
 * These classify to `EVAL_FAILED`.
 */
const EVAL_FAILED_CODES: ReadonlySet<string> = new Set([
  'FOUNDRY_REJECTED',
  // operation-failed codes
  'ACTIVATE_FAILED',
  'ADD_FAILED',
  'APPLY_FAILED',
  'BEGIN_FAILED',
  'CHAT_POST_FAILED',
  'CONSUME_FAILED',
  'CREATE_FAILED',
  'DELETE_FAILED',
  'ENRICH_FAILED',
  'REMOVE_FAILED',
  'ROLL_FAILED',
  'SCROLL_FACTORY_FAILED',
  'TOMESSAGE_FAILED',
  'UPDATE_FAILED',
  'USE_FAILED',
  'VIEW_FAILED',
  // an API call threw inside the evaluator
  'CREATE_THREW',
  'DELETE_THREW',
  'ROLL_THREW',
  'SHOW_THREW',
  'UPDATE_THREW',
  // pipeline returned null / timed out / produced no effect
  'CANVAS_REDRAW_TIMEOUT',
  'EXISTING_ITEM_LOST',
  'INCREASE_CONDITION_RETURNED_NULL',
  'INTERNAL_RESOLUTION_FAILURE',
  'NO_ID_RETURNED',
  'ROLL_RETURNED_NULL',
  'USE_HAD_NO_EFFECT',
  'USE_TIMED_OUT',
]);

/**
 * Domain codes that mean a Foundry subsystem was not ready when the tool
 * ran. These classify to `FOUNDRY_NOT_READY`.
 */
const FOUNDRY_NOT_READY_CODES: ReadonlySet<string> = new Set([
  'FOUNDRY_NOT_READY',
  'CANVAS_NOT_READY',
  'GAME_UNAVAILABLE',
  'FACTORY_UNAVAILABLE',
  'CONDITION_MANAGER_UNAVAILABLE',
  'CONSUME_UNAVAILABLE',
  'STATISTIC_UNAVAILABLE',
  'STATUS_EFFECTS_UNAVAILABLE',
  'TOMESSAGE_UNAVAILABLE',
  'ROLL_METHOD_MISSING',
  'NO_SHOW_METHOD',
]);

/**
 * Build a `ToolError` from an evaluator's error branch, classifying its
 * domain code into a coarse `ToolErrorCode`.
 *
 * The domain code is read from `err.code` when that is a real domain code,
 * else from `err.details.reason` (the two evaluator conventions). It maps
 * to `EVAL_FAILED` for Foundry-side rejections, `FOUNDRY_NOT_READY` for
 * subsystem-not-ready faults, and `INVALID_INPUT` for everything else —
 * not-found, wrong-type, bad-value, and "unsupported but valid" requests.
 * `INVALID_INPUT` is the deliberate default: an un-bucketed code (e.g. a
 * `*_MALFORMED` Foundry-data fault) is safer reported as bad input than as
 * an internal failure, and a newly added domain code needs no change here.
 *
 * `details` passes through unchanged so the documented `details.reason`
 * contract holds; when the domain code was sourced from `err.code` it is
 * also folded into `details.reason`, so every tool error surfaces the
 * domain code there uniformly.
 */
export function toolErrorFromEvaluator(err: EvaluatorError, messagePrefix?: string): ToolError {
  const domainCode =
    err.code !== 'INVALID_INPUT'
      ? err.code
      : typeof err.details?.reason === 'string'
        ? err.details.reason
        : err.code;
  const toolCode: ToolErrorCode = FOUNDRY_NOT_READY_CODES.has(domainCode)
    ? 'FOUNDRY_NOT_READY'
    : EVAL_FAILED_CODES.has(domainCode)
      ? 'EVAL_FAILED'
      : 'INVALID_INPUT';
  const details =
    err.code !== 'INVALID_INPUT' && err.details?.reason === undefined
      ? { ...err.details, reason: domainCode }
      : err.details;
  const message = messagePrefix ? `${messagePrefix}: ${err.message}` : err.message;
  return new ToolError(toolCode, message, details);
}
