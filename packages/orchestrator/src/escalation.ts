import type { OrchestratorConfig } from './config';
import type { Severity } from './ports';
import type { ControlState } from './ports';
import type { DataQuality, RiskState } from './types';

export interface Escalation {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

/**
 * Situation-based escalation, derived only from the risk state and data quality (pure). Event-driven escalations
 * (policy blocked a de-risk, execution failed, injection suspected, audit failure, in-doubt transaction) are raised by
 * the orchestrator at the point they happen.
 *
 * Severity:
 *   info  record it, show it on the dashboard
 *   warn  a human should look soon
 *   page  a human should look now: funds may be at risk and automation is blocked, degraded or blind
 */
export function assessEscalations(args: {
  risk: RiskState;
  data: DataQuality;
  state: Pick<ControlState, 'blindCycles'>;
  borrowing: boolean;
  config: OrchestratorConfig;
}): Escalation[] {
  const { risk, data, state, borrowing, config } = args;
  const out: Escalation[] = [];
  const hf =
    risk.healthFactorWad === null
      ? 'n/a'
      : `${risk.healthFactorWad / 10n ** 18n}.${((risk.healthFactorWad % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0')}`;

  switch (risk.level) {
    case 'watch':
      out.push({
        severity: 'info',
        code: 'RISK_WATCH',
        message: `health factor ${hf} is below the watch level`,
      });
      break;
    case 'danger':
      out.push({
        severity: 'warn',
        code: 'RISK_DANGER',
        message: `health factor ${hf} is in the danger band; trading is limited to risk reduction`,
      });
      break;
    case 'critical':
      out.push({
        severity: 'page',
        code: 'RISK_CRITICAL',
        message: `health factor ${hf} is critical; liquidation is close`,
      });
      break;
    case 'liquidatable':
      out.push({
        severity: 'page',
        code: 'POSITION_LIQUIDATABLE',
        message: `health factor ${hf}: the position can be liquidated now`,
      });
      break;
    case 'unknown':
      out.push({
        severity: 'warn',
        code: 'POSITION_UNVALUABLE',
        message: risk.note ?? 'the lending position cannot be valued',
      });
      break;
    default:
      break;
  }

  if (borrowing && data.blocking) {
    const blind = state.blindCycles + 1;
    out.push({
      severity: blind >= config.execution.staleCyclesBeforePage ? 'page' : 'warn',
      code:
        blind >= config.execution.staleCyclesBeforePage
          ? 'GUARDIAN_BLIND'
          : 'DATA_BLOCKING_WHILE_BORROWING',
      message: `${blind} consecutive cycle(s) without trustworthy data while a borrow is open: ${data.issues
        .filter((i) => i.blocking)
        .map((i) => i.code)
        .join(', ')}`,
    });
  }
  return out;
}
