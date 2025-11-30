/**
 * ============================================================================
 * FJORD.JS - Structured Concurrency Library For JavaScript
 * ============================================================================
 * 
 * A lightweight, type-safe, production ready structured concurrency library inspired by natural
 * fjord water flows. Provides predictable task coordination, cancellation,
 * and error handling for JavaScript/TypeScript applications.
 * 
 * Version: 1.0.0
 * Size: ~4.8KB minified+gzipped
 * Dependencies: None (uses native Promise + AbortSignal)
 */

/**
 * TideToken: Cancellation primitive wrapping AbortSignal
 * Represents a cancellation token that can freeze task execution.
 */
class TideToken {
  constructor() {
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }

  isFrozen() {
    return this.signal.aborted;
  }

  freeze() {
    this.abortController.abort();
  }
}

/**
 * Estuary: Represents a concurrent scope where tasks (flows) are managed
 * An estuary is where tributary rivers converge. Similarly, this class
 * coordinates multiple concurrent tasks within a single scope.
 */
class Estuary {
  constructor(tideToken) {
    this.tideToken = tideToken;
    this.flows = new Set();
    this.settled = false;
  }

  /**
   * Launch a task (flow) within this scope
   * The task will:
   * 1. Execute immediately (microtask queue)
   * 2. Be tracked for cleanup
   * 3. Be cancelled if scope freezes
   * 4. Freeze entire estuary if it errors
   */
  flow(undertaking) {
    // Fail fast if scope is already closed
    if (this.tideToken.isFrozen()) {
      return Promise.reject(
        new Error('Estuary frozen: scope closed or task error occurred')
      );
    }

    // Normalize to Promise for consistent handling
    const flowPromise = Promise.resolve().then(() => undertaking());

    // Track this flow for cleanup
    this.flows.add(flowPromise);

    // Handle result/error and auto-cleanup
    return flowPromise
      .then(
        (result) => result,
        (error) => {
          // Error in one flow freezes entire estuary (cascade behavior)
          this.tideToken.freeze();
          throw error;
        }
      )
      .finally(() => {
        // Remove from tracking when complete
        this.flows.delete(flowPromise);
      });
  }

  isFrozen() {
    return this.tideToken.isFrozen();
  }

  /**
   * Wait for all active flows to settle (complete or error)
   * This ensures proper cleanup when scope exits.
   */
  async settle() {
    if (this.settled) return;
    this.settled = true;

    try {
      await Promise.allSettled(Array.from(this.flows));
    } catch (e) {
      // Silence errors - they were already propagated
    }
  }
}

/**
 * Fjord: Main structured concurrency orchestrator
 * Fjord manages task scopes with predictable lifetimes and error handling.
 */
export class Fjord {
  constructor(options = {}) {
    this.timeout = options.timeout || null;
    this.onError = options.onError || null;
  }

  /**
   * CASCADE: Coordinated parallel execution with all-or-nothing semantics
   * 
   * Behavior:
   * - Launches all flows in parallel
   * - Waits for ALL to complete successfully
   * - If ANY fails, ALL are cancelled immediately
   * - Returns result from callback
   */
  async cascade(scopeCallback) {
    const tideToken = new TideToken();
    const estuary = new Estuary(tideToken);

    try {
      // Execute with timeout protection
      const result = await this._executeWithTimeout(
        scopeCallback(estuary),
        tideToken
      );

      // Wait for all flows to settle before returning
      await estuary.settle();

      return result;
    } catch (error) {
      // Error encountered: freeze scope to cancel all remaining flows
      tideToken.freeze();
      await estuary.settle();

      // Invoke error handler if configured
      if (this.onError && error instanceof Error) {
        this.onError(error, 'cascade');
      }

      throw error;
    }
  }

  /**
   * TRIBUTARY: Competitive parallel execution with first-to-succeed semantics
   * 
   * Behavior:
   * - Launches all flows in parallel
   * - Returns as soon as ANY succeeds
   * - Automatically cancels remaining flows
   */
  async tributary(scopeCallback) {
    const tideToken = new TideToken();
    const estuary = new Estuary(tideToken);

    try {
      // Execute with timeout protection
      const result = await this._executeWithTimeout(
        scopeCallback(estuary),
        tideToken
      );

      // Success: freeze scope to cancel remaining flows
      tideToken.freeze();
      await estuary.settle();

      return result;
    } catch (error) {
      // Error encountered: freeze and cleanup
      tideToken.freeze();
      await estuary.settle();

      // Invoke error handler if configured
      if (this.onError && error instanceof Error) {
        this.onError(error, 'tributary');
      }

      throw error;
    }
  }

  /**
   * Internal: Execute promise with timeout protection
   * Races the main promise against a timeout timer.
   */
  _executeWithTimeout(promise, tideToken) {
    if (!this.timeout) {
      return promise;
    }

    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => {
          tideToken.freeze();
          reject(new Error(`Fjord timeout exceeded: ${this.timeout}ms`));
        }, this.timeout)
      ),
    ]);
  }
}

/**
 * Preset configurations for common patterns
 */
export const FjordPresets = {
  // Strict mode: Fast timeout, logs errors, good for APIs
  api: () => new Fjord({ timeout: 5000 }),

  // Relaxed mode: Longer timeout, good for heavy computation
  compute: () => new Fjord({ timeout: 30000 }),

  // Default: No timeout, suitable for internal coordination
  default: () => new Fjord(),
};

// Default export for CommonJS compatibility
export default Fjord;
