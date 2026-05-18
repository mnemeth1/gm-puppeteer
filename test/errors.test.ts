import { describe, expect, it } from 'vitest';
import { ToolError, toolErrorFromEvaluator } from '../src/errors.js';

describe('toolErrorFromEvaluator', () => {
  it('classifies a Foundry-rejection reason as EVAL_FAILED', () => {
    const err = toolErrorFromEvaluator({
      code: 'INVALID_INPUT',
      message: 'create failed',
      details: { reason: 'CREATE_FAILED' },
    });
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe('EVAL_FAILED');
    expect(err.details).toEqual({ reason: 'CREATE_FAILED' });
  });

  it('classifies a not-found reason as INVALID_INPUT', () => {
    const err = toolErrorFromEvaluator({
      code: 'INVALID_INPUT',
      message: 'no actor',
      details: { reason: 'ACTOR_NOT_FOUND', actorId: 'x' },
    });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.details).toEqual({ reason: 'ACTOR_NOT_FOUND', actorId: 'x' });
  });

  it('classifies a subsystem-not-ready reason as FOUNDRY_NOT_READY', () => {
    const err = toolErrorFromEvaluator({
      code: 'INVALID_INPUT',
      message: 'not ready',
      details: { reason: 'FOUNDRY_NOT_READY' },
    });
    expect(err.code).toBe('FOUNDRY_NOT_READY');
  });

  it('classifies a domain code carried in error.code', () => {
    const err = toolErrorFromEvaluator({ code: 'FOUNDRY_REJECTED', message: 'rejected' });
    expect(err.code).toBe('EVAL_FAILED');
  });

  it('folds a code-sourced domain code into details.reason', () => {
    const err = toolErrorFromEvaluator({
      code: 'SCENE_NOT_FOUND',
      message: 'no scene',
      details: { sceneId: 'missing' },
    });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.details).toEqual({ sceneId: 'missing', reason: 'SCENE_NOT_FOUND' });
  });

  it('defaults an un-bucketed code to INVALID_INPUT', () => {
    const err = toolErrorFromEvaluator({
      code: 'INVALID_INPUT',
      message: 'bad value',
      details: { reason: 'INVALID_QUANTITY' },
    });
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('leaves details undefined when the evaluator supplied none', () => {
    const err = toolErrorFromEvaluator({ code: 'INVALID_INPUT', message: 'plain' });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.details).toBeUndefined();
  });

  it('applies the optional message prefix', () => {
    const err = toolErrorFromEvaluator(
      { code: 'SCENE_NOT_FOUND', message: 'no scene' },
      'delete_token recovery',
    );
    expect(err.message).toBe('delete_token recovery: no scene');
  });
});
