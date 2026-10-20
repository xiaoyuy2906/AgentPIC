import type { CheckResult } from './contracts.js';

export function check(
  id: string,
  ok: boolean,
  detail: string,
  evidence: Record<string, unknown> = {},
): CheckResult {
  return { id, status: ok ? 'pass' : 'fail', detail, evidence };
}
