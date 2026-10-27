import { EventEmitter } from 'events';
import { CallState, StateTransition } from '../types/session.types.js';

export class InvalidStateTransitionError extends Error {
  constructor(public from: CallState, public to: CallState, public trigger: string) {
    super(`Invalid call state transition from ${from} to ${to} triggered by "${trigger}"`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class CallStateMachine extends EventEmitter {
  private currentState: CallState;
  private readonly history: StateTransition[] = [];
  private readonly startTime: number;
  private endTime: number | null = null;
  private failureReason: string | null = null;

  // Allowed state transitions table
  private static readonly ALLOWED_TRANSITIONS: Record<CallState, CallState[]> = {
    [CallState.INITIALIZING]: [
      CallState.RESERVING,
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.RESERVING]: [
      CallState.RINGING,
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.RINGING]: [
      CallState.ACTIVE,
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.ACTIVE]: [
      CallState.SPEAKING,
      CallState.LISTENING,
      CallState.PROCESSING,
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.SPEAKING]: [
      CallState.LISTENING,  // Barge-in or turn end
      CallState.PROCESSING, // Direct tool or intent switch
      CallState.ACTIVE,     // Intermediate idle
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.LISTENING]: [
      CallState.PROCESSING, // User finished speaking
      CallState.SPEAKING,   // Direct agent interjection
      CallState.ACTIVE,     // Intermediate idle
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.PROCESSING]: [
      CallState.SPEAKING,   // LLM response ready
      CallState.LISTENING,  // Speech resumed
      CallState.ACTIVE,     // Intermediate idle
      CallState.TERMINATING,
      CallState.FAILED,
    ],
    [CallState.TERMINATING]: [
      CallState.SETTLING,
      CallState.COMPLETED,
      CallState.FAILED,
    ],
    [CallState.SETTLING]: [
      CallState.COMPLETED,
      CallState.FAILED,
    ],
    [CallState.COMPLETED]: [], // Terminal state
    [CallState.FAILED]: [],    // Terminal state
  };

  constructor(initialState: CallState = CallState.INITIALIZING) {
    super();
    this.currentState = initialState;
    this.startTime = Date.now();
    this.history.push({
      from: initialState,
      to: initialState,
      trigger: 'SESSION_INITIALIZED',
      timestamp: this.startTime,
    });
  }

  getState(): CallState {
    return this.currentState;
  }

  getHistory(): ReadonlyArray<StateTransition> {
    return this.history;
  }

  isTerminal(): boolean {
    return this.currentState === CallState.COMPLETED || this.currentState === CallState.FAILED;
  }

  isTerminatingOrDone(): boolean {
    return (
      this.currentState === CallState.TERMINATING ||
      this.currentState === CallState.SETTLING ||
      this.isTerminal()
    );
  }

  getDurationMs(): number {
    const end = this.endTime ?? Date.now();
    return Math.max(0, end - this.startTime);
  }

  getFailureReason(): string | null {
    return this.failureReason;
  }

  /**
   * Validate and perform a state transition.
   */
  transition(to: CallState, trigger: string, reason?: string, metadata?: Record<string, any>): StateTransition {
    // Check if already in requested state
    if (this.currentState === to) {
      return this.history[this.history.length - 1];
    }

    // Check if transition is valid
    const allowed = CallStateMachine.ALLOWED_TRANSITIONS[this.currentState];
    if (!allowed || !allowed.includes(to)) {
      throw new InvalidStateTransitionError(this.currentState, to, trigger);
    }

    const previousState = this.currentState;
    this.currentState = to;
    const now = Date.now();

    if (this.isTerminal() && !this.endTime) {
      this.endTime = now;
    }

    if (to === CallState.FAILED && reason) {
      this.failureReason = reason;
    }

    const transitionRecord: StateTransition = {
      from: previousState,
      to,
      trigger,
      timestamp: now,
      reason,
      metadata,
    };

    this.history.push(transitionRecord);
    this.emit('transition', transitionRecord);
    this.emit(to, transitionRecord);

    return transitionRecord;
  }

  /**
   * Idempotent termination.
   * Safe to call multiple times from concurrent events, timeouts, or carrier disconnects.
   */
  terminate(reason: string = 'Normal Hangup', failed: boolean = false): StateTransition {
    // If already terminal, return last transition record without error
    if (this.isTerminal()) {
      return this.history[this.history.length - 1];
    }

    // If currently settling or terminating, complete to appropriate terminal state
    if (this.currentState === CallState.SETTLING || this.currentState === CallState.TERMINATING) {
      const finalTarget = failed ? CallState.FAILED : CallState.COMPLETED;
      return this.transition(finalTarget, 'TERMINATION_FINALIZED', reason);
    }

    // Transition to TERMINATING first
    this.transition(CallState.TERMINATING, 'TERMINATE_REQUESTED', reason);
    return this.history[this.history.length - 1];
  }
}
