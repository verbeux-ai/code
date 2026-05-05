import { useEffect, useRef, useState } from 'react'

/**
 * Ref compartilhado que o REPL atualiza durante o streaming.
 * O hook lê este ref a cada polling cycle.
 */
export interface StreamingMetrics {
  responseLength: number
  baselineLength: number
  firstTokenTime: number
  lastTokenTime: number
  isStreaming: boolean
}

export const streamingMetricsRef: { current: StreamingMetrics } = {
  current: {
    responseLength: 0,
    baselineLength: 0,
    firstTokenTime: 0,
    lastTokenTime: 0,
    isStreaming: false
  }
}

/**
 * Hook que calcula a taxa de tokens/s de output do modelo em tempo real.
 *
 * Usa o streamingMetricsRef compartilhado, atualizado pelo REPL durante streaming.
 * Tokens são estimados como caracteres / 4 (média para texto em inglês).
 */
export function useTokenRate(): {
  rate: number
  isStreaming: boolean
} {
  const [rate, setRate] = useState(0)
  const [isStreaming, setIsStreaming] = useState(false)
  const lastLengthRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(Date.now())
  const rateHistoryRef = useRef<{ timestamp: number; rate: number }[]>([])

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const m = streamingMetricsRef.current

      setIsStreaming(m.isStreaming)

      if (m.isStreaming && m.responseLength > 0 && m.responseLength !== lastLengthRef.current) {
        const deltaChars = m.responseLength - lastLengthRef.current
        const deltaTokens = Math.max(1, Math.round(deltaChars / 4))
        const deltaMs = now - lastTimeRef.current

        if (deltaMs > 10 && deltaMs < 3000) {
          const instantRate = (deltaTokens / deltaMs) * 1000
          if (instantRate > 0.5 && instantRate < 500) {
            rateHistoryRef.current.push({ timestamp: now, rate: instantRate })
          }
        }

        lastLengthRef.current = m.responseLength
        lastTimeRef.current = now
      }

      // Remove entradas antigas (>10s)
      const cutoff = now - 10_000
      rateHistoryRef.current = rateHistoryRef.current.filter(e => e.timestamp > cutoff)

      if (rateHistoryRef.current.length > 0) {
        const avgRate = rateHistoryRef.current.reduce((sum, e) => sum + e.rate, 0) / rateHistoryRef.current.length
        setRate(Math.round(avgRate))
      } else {
        setRate(0)
      }
    }, 100)

    return () => clearInterval(interval)
  }, [])

  return { rate, isStreaming }
}

/**
 * Hook compatível com a assinatura anterior.
 */
export function useTokenRateDetailed(_messages: readonly any[]): {
  instantRate: number
  avgRate10s: number
  isGenerating: boolean
} {
  const { rate, isStreaming } = useTokenRate()
  return {
    instantRate: rate,
    avgRate10s: rate,
    isGenerating: isStreaming
  }
}