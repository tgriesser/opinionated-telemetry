import type { Instrumentation } from '@opentelemetry/instrumentation'
import type { OpinionatedOptions } from './types.js'

/**
 * Module-level registry mapping instrumentation scope names to their opinionated options.
 * The FilteringSpanProcessor reads from this registry using span.instrumentationScope.name.
 */
const registry = new Map<string, OpinionatedOptions>()

export class OpinionatedInstrumentation {
  public readonly instrumentation: Instrumentation
  public readonly options: OpinionatedOptions

  /**
   * Wraps an already-constructed instrumentation instance with opinionated options.
   *
   *   new OpinionatedInstrumentation(new KnexInstrumentation(), { collapse: true })
   */
  constructor(instrumentation: Instrumentation, options?: OpinionatedOptions) {
    this.instrumentation = instrumentation
    this.options = options ?? {}

    // Register in the module-level registry
    const name = this.instrumentation.instrumentationName
    if (name) {
      registry.set(name, this.options)
    }
  }

  /**
   * Get the opinionated options for a given instrumentation scope name.
   */
  static getOptions(scopeName: string): OpinionatedOptions | undefined {
    return registry.get(scopeName)
  }

  /**
   * Check if a scope has opinionated options registered.
   */
  static hasOptions(scopeName: string): boolean {
    return registry.has(scopeName)
  }

  /**
   * Get a snapshot of all registered options (for debugging).
   */
  static getAllOptions(): ReadonlyMap<string, OpinionatedOptions> {
    return registry
  }

  /**
   * Clear all registered options. Useful for re-initialization or test cleanup.
   */
  static clearRegistry(): void {
    registry.clear()
  }
}
