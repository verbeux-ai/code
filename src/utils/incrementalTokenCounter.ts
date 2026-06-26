/**
 * High-performance token counter with cache invalidation on content change.
 *
 * Uses lightweight length-based cache keys instead of expensive SHA-256 hashing.
 * Never resets internal state on empty-message queries — just returns 0.
 */

import { roughTokenCountEstimation, roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'

export interface IncrementalCounterConfig {
  /** Token budget for context limit decisions (e.g., model context window) */
  tokenBudget?: number
  /** Enable auto-invalidation on size change */
  autoInvalidate?: boolean
  /** Custom estimation multiplier */
  estimationMultiplier?: number
}

export interface CounterStats {
  hits: number
  misses: number
  totalTokens: number
  averageTokens: number
  hitRate: number
}

/**
 * Lightweight cache key — total character length of all message content.
 * Much cheaper than SHA-256 and sufficient for cache-hit detection:
 * if every message has the same content length, the token estimate
 * is guaranteed identical.
 */
function getContentLength(messages: readonly Message[]): number {
  let len = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    const c = msg.message?.content
    if (typeof c === 'string') {
      len += c.length
    } else if (Array.isArray(c)) {
      for (let j = 0; j < c.length; j++) {
        const block = c[j]
        if (!block) continue
        if (typeof (block as any).text === 'string') {
          len += (block as any).text.length
        } else if (typeof (block as any).thinking === 'string') {
          len += (block as any).thinking.length
        }
      }
    }
  }
  return len
}

/**
 * High-performance incremental token counter with content-aware invalidation.
 */
export class IncrementalTokenCounter {
  private lastMessageCount = 0
  private lastTokenCount = 0
  /** Total character length of all messages at last cache (lightweight cache key) */
  private lastContentLength = 0
  /** Content length of the prefix (first N messages) for incremental detection */
  private lastPrefixContentLength = 0
  private config: Required<IncrementalCounterConfig>
  private stats = {
    hits: 0,
    misses: 0,
    totalTokens: 0,
  }

  constructor(config: IncrementalCounterConfig = {}) {
    this.config = {
      tokenBudget: config.tokenBudget ?? 100000,
      autoInvalidate: config.autoInvalidate ?? true,
      estimationMultiplier: config.estimationMultiplier ?? 1,
    }
  }

  /**
   * Get token count using cache when possible.
   * O(1) for cached, O(n) for new messages.
   */
  getCount(messages: readonly Message[]): number {
    if (messages.length === 0) {
      // Don't reset — just return 0. Resetting destroys the cache and
      // causes the next legitimate query to do a full recalculate.
      return 0
    }

    const contentLength = getContentLength(messages)

    // Cache hit: same number of messages with the same total content length.
    // Uses character length instead of SHA-256 for O(1) cache-key cost.
    if (
      messages.length === this.lastMessageCount &&
      contentLength === this.lastContentLength
    ) {
      this.stats.hits++
      this.stats.totalTokens += this.lastTokenCount
      return this.lastTokenCount
    }

    // Cache miss - calculate
    this.stats.misses++

    const isIncrementalSafe =
      messages.length > this.lastMessageCount &&
      this.config.autoInvalidate &&
      this.lastMessageCount > 0

    if (isIncrementalSafe) {
      // Check if the prefix (existing messages) is unchanged
      const prefixContentLength = getContentLength(
        messages.slice(0, this.lastMessageCount) as Message[],
      )

      if (prefixContentLength === this.lastPrefixContentLength) {
        // Only new messages appended — estimate incrementally
        const newMessages = messages.slice(this.lastMessageCount)
        const estimated = Math.round(
          roughTokenCountEstimationForMessages(newMessages) * this.config.estimationMultiplier,
        )
        this.lastTokenCount += estimated
      } else {
        // Prefix changed — full recalculate
        this.lastTokenCount = roughTokenCountEstimationForMessages(messages)
      }
    } else {
      this.lastTokenCount = roughTokenCountEstimationForMessages(messages)
    }

    this.lastMessageCount = messages.length
    this.lastContentLength = contentLength
    this.lastPrefixContentLength = getContentLength(
      messages.slice(0, messages.length) as Message[],
    )
    this.stats.totalTokens += this.lastTokenCount

    return this.lastTokenCount
  }

  /**
   * Force recalculate from full context.
   * Use when context changed externally.
   */
  invalidate(messages: readonly Message[]): number {
    this.lastMessageCount = messages.length
    this.lastContentLength = getContentLength(messages)
    this.lastPrefixContentLength = messages.length > 0 ? getContentLength(messages) : 0

    if (messages.length === 0) {
      this.lastTokenCount = 0
    } else {
      this.lastTokenCount = roughTokenCountEstimationForMessages(messages)
    }

    this.stats.totalTokens += this.lastTokenCount
    this.stats.misses++

    return this.lastTokenCount
  }

  /**
   * Estimate token count without caching.
   * Useful for read-only estimates.
   */
  estimate(messages: readonly Message[]): number {
    return roughTokenCountEstimationForMessages(messages)
  }

  /**
   * Get token count for a single message.
   */
  estimateMessage(message: Message): number {
    if (typeof message.message?.content === 'string') {
      return roughTokenCountEstimation(message.message.content)
    }
    if (Array.isArray(message.message?.content)) {
      return message.message.content.reduce((sum, block) => {
        if ('text' in block) return sum + roughTokenCountEstimation(block.text || '')
        if ('thinking' in block) return sum + roughTokenCountEstimation(block.thinking || '')
        return sum + 100 // Default for other block types
      }, 0)
    }
    return 100 // Default estimate
  }

  /**
   * Batch estimate for multiple messages.
   */
  estimateBatch(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessage(msg), 0)
  }

  /**
   * Get remaining budget in context window.
   */
  getRemainingBudget(messages: readonly Message[], contextWindow: number): number {
    const used = this.getCount(messages)
    return Math.max(0, contextWindow - used)
  }

  /**
   * Check if approaching limit.
   */
  isApproachingLimit(messages: readonly Message[], threshold: number = 0.8): boolean {
    return this.lastMessageCount > 0 &&
           (this.lastTokenCount / this.config.tokenBudget) > threshold
  }

  /** Reset all state */
  reset(): void {
    this.lastMessageCount = 0
    this.lastTokenCount = 0
    this.lastContentLength = 0
    this.lastPrefixContentLength = 0
    this.stats = { hits: 0, misses: 0, totalTokens: 0 }
  }

  /** Get current cached count */
  get cachedCount(): number {
    return this.lastTokenCount
  }

  /** Get message count */
  get messageCount(): number {
    return this.lastMessageCount
  }

  /** Get statistics */
  getStats(): CounterStats {
    const total = this.stats.hits + this.stats.misses
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      totalTokens: this.stats.totalTokens,
      averageTokens: total > 0 ? Math.round(this.stats.totalTokens / total) : 0,
      hitRate: total > 0 ? Math.round((this.stats.hits / total) * 100) : 0,
    }
  }

  /** Update configuration dynamically */
  updateConfig(config: Partial<IncrementalCounterConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      tokenBudget: config.tokenBudget ?? this.config.tokenBudget,
      autoInvalidate: config.autoInvalidate ?? this.config.autoInvalidate,
      estimationMultiplier: config.estimationMultiplier ?? this.config.estimationMultiplier,
    }
  }
}

/**
 * Factory for creating pre-configured counters.
 */
export const CounterFactory = {
  realtime(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({
      tokenBudget: 50000,
      autoInvalidate: true,
      estimationMultiplier: 1.1,
    })
  },

  batch(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({
      tokenBudget: 200000,
      autoInvalidate: false,
      estimationMultiplier: 1.0,
    })
  },

  lightweight(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({
      tokenBudget: 10000,
      autoInvalidate: true,
      estimationMultiplier: 1.2,
    })
  },
}
