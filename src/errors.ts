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
