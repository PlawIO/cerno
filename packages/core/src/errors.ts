import { ErrorCode } from './types.js'

export class CaptchaError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'CaptchaError'
  }
}
