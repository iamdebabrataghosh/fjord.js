/**
 * ============================================================================
 * FJORD.JS - Structured Concurrency Library
 * ============================================================================
 * 
 * A lightweight, type-safe structured concurrency library inspired by natural
 * fjord water flows. Provides predictable task coordination, cancellation,
 * and error handling for JavaScript/TypeScript applications.
 * 
 * Version: 1.0.0
 * Size: ~4.8KB minified+gzipped
 * Dependencies: None (uses native Promise + AbortSignal)
 * 
 * @example
 * ```typescript
 * const fjord = new Fjord();
 * 
 * // Cascade: Wait for all tasks, cancel all on error
 * await fjord.cascade(async (estuary) => {
 *   const data1 = estuary.flow(() => fetchUser());
 *   const data2 = estuary.flow(() => fetchOrders());
 *   return Promise.all([data1, data2]);
 * });
 * 
 * // Tributary: First-to-succeed race pattern
 * const fastest = await fjord.tributary(async (estuary) => {
 *   return Promise.race([
 *     estuary.flow(() => fetchPrimary()),
 *     estuary.flow(() => fetchBackup()),
 *   ]);
 * });
 * ```
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Configuration options for Fjord instance
 */
export interface FjordOptions {
  /** Maximum execution time in milliseconds. Rejects with timeout error if exceeded. */
  timeout?: number;
  
  /** Error handler callback invoked when a scope fails */
  onError?: (error: Error, mode: 'cascade' | 'tributary') => void;
}

/**
 * Scope context passed to callback functions.
 * Provides access to task launching and scope state.
 */
export interface EstuaryScope {
  /**
   * Launch an async task within the current scope.
   * Task will be cancelled if scope closes or errors.
   */
  flow<T>(undertaking: () => Promise<T> | T): Promise<T>;
  
  /** Check if the scope is frozen (closed or cancelled) */
  isFrozen(): boolean;
}

/**
 * Callback function type for scope operations
 */
export type ScopeCallback<T> = (estuary: EstuaryScope) => Promise<T>;

// ============================================================================
// CORE CLASSES
// ============================================================================

/**
 * TideToken: Cancellation primitive wrapping AbortSignal
 * 
 * Represents a cancellation token that can freeze task execution.
 * Uses native AbortSignal for maximum compatibility with browser/Node.js APIs.
 * 
 * Metaphor: Like closing a fjord's inlet gates to halt water flow
 */
class TideToken {
  private abortController: AbortController;
  
  /** Native AbortSignal for integration with fetch, setTimeout, etc. */
  signal: AbortSignal;

  constructor() {
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }

  /**
   * Check if this token has been frozen (aborted)
   */
  isFrozen(): boolean {
    return this.signal.aborted;
  }

  /**
   * Freeze the token, triggering all cancellations
   * Metaphor: Closing the fjord's floodgates
   */
  freeze(): void {
    this.abortController.abort();
  }
}

/**
 * Estuary: Represents a concurrent scope where tasks (flows) are managed
 * 
 * An estuary is where tributary rivers converge. Similarly, this class
 * coordinates multiple concurrent tasks within a single scope.
 * 
 * Key responsibilities:
 * - Track all launched tasks (flows)
 * - Enforce scope boundaries (frozen state)
 * - Coordinate task settlement (cleanup)
 * 
 * Metaphor: Like an estuary where water currents (flows) merge and diverge
 */
class Estuary implements EstuaryScope {
  private tideToken: TideToken;
  private flows: Set<Promise<any>> = new Set();
  private settled: boolean = false;

  constructor(tideToken: TideToken) {
    this.tideToken = tideToken;
  }

  /**
   * Launch a task (flow) within this scope
   * 
   * The task will:
   * 1. Execute immediately (microtask queue)
   * 2. Be tracked for cleanup
   * 3. Be cancelled if scope freezes
   * 4. Freeze entire estuary if it errors
   * 
   * @param undertaking - Async function or Promise-returning callable
   * @returns Promise that resolves/rejects with task result
   * 
   * Metaphor: Launching a current/flow into the estuary
   */
  flow<T>(undertaking: () => Promise<T> | T): Promise<T> {
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

  /**
   * Check if this scope is frozen
   */
  isFrozen(): boolean {
    return this.tideToken.isFrozen();
  }

  /**
   * Wait for all active flows to settle (complete or error)
   * 
   * This ensures proper cleanup when scope exits.
   * Uses allSettled to prevent one error from blocking others.
   */
  async settle(): Promise<void> {
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
 * 
 * Fjord manages task scopes with predictable lifetimes and error handling.
 * It provides two primary coordination patterns:
 * - cascade(): All tasks must succeed or all are cancelled
 * - tributary(): First success wins, others cancelled
 * 
 * Metaphor: A fjord is a narrow waterway where currents converge and diverge
 */
export class Fjord {
  private timeout: number | null;
  private onError: ((error: Error, mode: 'cascade' | 'tributary') => void) | null;

  constructor(options: FjordOptions = {}) {
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
   * 
   * Perfect for:
   * - Fetching multiple dependent resources
   * - Coordinating initialization steps
   * - Ensuring atomic group completion
   * 
   * @param scopeCallback - Function receiving estuary, launches flows
   * @returns Promise with final result
   * @throws Error if any task fails or timeout exceeded
   * 
   * @example
   * ```typescript
   * const [user, posts] = await fjord.cascade(async (estuary) => {
   *   const user = estuary.flow(() => fetchUser(id));
   *   const posts = estuary.flow(() => fetchPosts(id));
   *   return Promise.all([user, posts]);
   * });
   * ```
   * 
   * Metaphor: Like a waterfall cascading down - all water flows together
   */
  async cascade<T>(scopeCallback: ScopeCallback<T>): Promise<T> {
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
   * - Useful for redundancy and failover
   * 
   * Perfect for:
   * - Racing multiple data sources (primary/backup/cache)
   * - Failover patterns
   * - Connection pooling
   * - Speculative execution
   * 
   * @param scopeCallback - Function receiving estuary, launches flows
   * @returns Promise with result from first successful task
   * @throws Error if all tasks fail or timeout exceeded
   * 
   * @example
   * ```typescript
   * const data = await fjord.tributary(async (estuary) => {
   *   return Promise.race([
   *     estuary.flow(() => fetchFromPrimary()),
   *     estuary.flow(() => fetchFromBackup()),
   *     estuary.flow(() => fetchFromCache()),
   *   ]);
   * });
   * ```
   * 
   * Metaphor: Like tributaries merging - first one to reach wins
   */
  async tributary<T>(scopeCallback: ScopeCallback<T>): Promise<T> {
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
   * 
   * Races the main promise against a timeout timer.
   * If timeout wins, freezes the scope to cancel all tasks.
   * 
   * @param promise - Main async operation
   * @param tideToken - Token to freeze on timeout
   * @returns Promise that rejects on timeout
   */
  private _executeWithTimeout<T>(
    promise: Promise<T>,
    tideToken: TideToken
  ): Promise<T> {
    if (!this.timeout) {
      return promise;
    }

    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
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
  /**
   * Strict mode: Fast timeout, logs errors, good for APIs
   */
  api: () => new Fjord({ timeout: 5000 }),

  /**
   * Relaxed mode: Longer timeout, good for heavy computation
   */
  compute: () => new Fjord({ timeout: 30000 }),

  /**
   * Default: No timeout, suitable for internal coordination
   */
  default: () => new Fjord(),
};

// Export for compatibility
export default Fjord;
