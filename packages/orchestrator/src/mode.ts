import type { Clock } from '@near-autopilot/core';
import type { ControlState, ControlStore } from './ports';
import type { AgentId } from './proposals';
import type { Mode } from './types';

/**
 * Operating-mode state machine.
 *
 *   normal --(operator, or the system on a safety trigger)--> risk_reduction_only --> read_only
 *   read_only --(operator ONLY, with a named actor and a reason)--> normal
 *
 * The system may tighten the mode on its own (repeated execution failures, an in-doubt transaction, suspected prompt
 * injection, an audit failure) but never loosens it: leaving read-only requires an explicit operator call. If the
 * control state cannot be read, the controller answers "read_only" rather than guessing.
 */
export class ModeController {
  constructor(
    private readonly store: ControlStore,
    private readonly clock: Clock,
  ) {}

  /** Never throws. An unreadable store yields a synthetic read-only state. */
  async current(): Promise<ControlState> {
    return (await this.read()).state;
  }

  private async read(): Promise<{ state: ControlState; synthetic: boolean }> {
    try {
      return { state: await this.store.load(), synthetic: false };
    } catch (error) {
      const state: ControlState = {
        mode: 'read_only',
        reason: `control state unreadable (${error instanceof Error ? error.message : String(error)}); failing safe`,
        since: this.clock.now(),
        changedBy: 'system',
        consecutiveFailures: 0,
        blindCycles: 0,
        quarantined: {},
      };
      return { state, synthetic: true };
    }
  }

  /**
   * Applies `patch` and persists it. When the stored state could not be read, the patch was applied to the synthetic
   * fail-safe state (no quarantines, zeroed counters); saving that would silently erase the real state, so it is
   * only kept in memory, except for an explicit emergency read-only, which is worth persisting regardless.
   */
  private async update(
    patch: (s: ControlState) => ControlState,
    persistIfUnreadable = false,
  ): Promise<ControlState> {
    const { state, synthetic } = await this.read();
    const next = patch(state);
    if (synthetic && !persistIfUnreadable) return next;
    try {
      await this.store.save(next);
    } catch {
      // Could not persist. The caller still gets the stricter in-memory view for the remainder of this cycle.
    }
    return next;
  }

  /** The system tightening the mode. Idempotent and never loosens: asking for a milder mode than the current one is a no-op. */
  async tighten(mode: Mode, reason: string, by = 'system'): Promise<ControlState> {
    const rank = { normal: 0, risk_reduction_only: 1, read_only: 2 } as const;
    return this.update((s) =>
      rank[mode] > rank[s.mode]
        ? { ...s, mode, reason, since: this.clock.now(), changedBy: by }
        : s,
    );
  }

  /** Operator action: emergency read-only. */
  engageReadOnly(reason: string, by: string): Promise<ControlState> {
    if (!by.trim() || !reason.trim())
      throw new RangeError('engaging read-only mode needs an actor and a reason');
    return this.update(
      (s) => ({
        ...s,
        mode: 'read_only',
        reason,
        since: this.clock.now(),
        changedBy: by,
      }),
      true,
    );
  }

  /** Operator action: set any mode, including loosening. Needs a named actor and a reason; resets the failure counters. */
  setMode(mode: Mode, reason: string, by: string): Promise<ControlState> {
    if (!by.trim() || !reason.trim())
      throw new RangeError('changing the mode needs an actor and a reason');
    return this.update((s) => ({
      ...s,
      mode,
      reason,
      since: this.clock.now(),
      changedBy: by,
      consecutiveFailures: 0,
      blindCycles: 0,
    }));
  }

  recordExecution(success: boolean): Promise<ControlState> {
    return this.update((s) => ({
      ...s,
      consecutiveFailures: success ? 0 : s.consecutiveFailures + 1,
    }));
  }

  recordBlindCycle(blind: boolean): Promise<ControlState> {
    return this.update((s) => ({ ...s, blindCycles: blind ? s.blindCycles + 1 : 0 }));
  }

  quarantine(agent: AgentId, reason: string): Promise<ControlState> {
    return this.update((s) =>
      s.quarantined[agent]
        ? s
        : { ...s, quarantined: { ...s.quarantined, [agent]: { since: this.clock.now(), reason } } },
    );
  }

  /** Operator action. */
  releaseAgent(agent: AgentId, by: string): Promise<ControlState> {
    if (!by.trim()) throw new RangeError('releasing an agent needs an actor');
    return this.update((s) => {
      const { [agent]: _removed, ...rest } = s.quarantined;
      return { ...s, quarantined: rest };
    });
  }
}
