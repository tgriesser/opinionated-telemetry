import { metrics, type Meter } from '@opentelemetry/api'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { PerformanceObserver } from 'node:perf_hooks'

export interface NodeRuntimeMetricsConfig {
  /** Meter instance to use. Default: metrics.getMeter('opin_tel.runtime') */
  meter?: Meter
  /** Metric name prefix. Default: 'node' */
  prefix?: string
  /** Event loop delay monitor resolution in ms. Default: 20 */
  eventLoopDelayResolution?: number
  /** Selectively enable/disable metric groups. All default true. */
  enable?: {
    eventLoopDelay?: boolean
    heap?: boolean
    gc?: boolean
    handlesRequests?: boolean
    cpu?: boolean
    memory?: boolean
  }
}

interface GcStats {
  count: number
  totalMs: number
  maxMs: number
  durations: number[]
}

export class NodeRuntimeMetrics {
  private _config: NodeRuntimeMetricsConfig
  private _started = false
  private _histogram: IntervalHistogram | null = null
  private _gcObserver: PerformanceObserver | null = null
  private _gcStats: GcStats = { count: 0, totalMs: 0, maxMs: 0, durations: [] }
  private _prevCpuUsage: NodeJS.CpuUsage | null = null
  private _prevCpuTime: number = 0

  constructor(config: NodeRuntimeMetricsConfig = {}) {
    this._config = config
  }

  start(): void {
    if (this._started) return
    this._started = true

    const meter = this._config.meter ?? metrics.getMeter('opin_tel.runtime')
    const prefix = this._config.prefix ?? 'node'
    const enable = this._config.enable ?? {}

    // Event Loop Delay
    if (enable.eventLoopDelay !== false) {
      this._histogram = monitorEventLoopDelay({
        resolution: this._config.eventLoopDelayResolution ?? 20,
      })
      this._histogram.enable()

      const eldP50 = meter.createObservableGauge(
        `${prefix}.eventloop.delay.p50`,
      )
      const eldP99 = meter.createObservableGauge(
        `${prefix}.eventloop.delay.p99`,
      )
      const eldMax = meter.createObservableGauge(
        `${prefix}.eventloop.delay.max`,
      )

      const histogram = this._histogram
      meter.addBatchObservableCallback(
        (observer) => {
          if (!histogram) return
          observer.observe(eldP50, histogram.percentile(50) / 1e6)
          observer.observe(eldP99, histogram.percentile(99) / 1e6)
          observer.observe(eldMax, histogram.max / 1e6)
          histogram.reset()
        },
        [eldP50, eldP99, eldMax],
      )
    }

    // Heap
    if (enable.heap !== false) {
      const heapUsed = meter.createObservableGauge(`${prefix}.heap.used_mb`)
      const heapTotal = meter.createObservableGauge(`${prefix}.heap.total_mb`)
      const heapPct = meter.createObservableGauge(`${prefix}.heap.used_pct`)

      meter.addBatchObservableCallback(
        (observer) => {
          const mem = process.memoryUsage()
          const usedMb = mem.heapUsed / (1024 * 1024)
          const totalMb = mem.heapTotal / (1024 * 1024)
          observer.observe(heapUsed, usedMb)
          observer.observe(heapTotal, totalMb)
          observer.observe(heapPct, totalMb > 0 ? (usedMb / totalMb) * 100 : 0)
        },
        [heapUsed, heapTotal, heapPct],
      )
    }

    // GC (major only, kind=2)
    if (enable.gc !== false) {
      this._gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // kind 2 = major GC
          if ((entry as any).detail?.kind === 2) {
            const durationMs = entry.duration
            this._gcStats.count++
            this._gcStats.totalMs += durationMs
            if (durationMs > this._gcStats.maxMs) {
              this._gcStats.maxMs = durationMs
            }
            this._gcStats.durations.push(durationMs)
          }
        }
      })
      this._gcObserver.observe({ type: 'gc', buffered: true })

      const gcCount = meter.createObservableGauge(`${prefix}.gc.major.count`)
      const gcAvg = meter.createObservableGauge(`${prefix}.gc.major.avg_ms`)
      const gcMax = meter.createObservableGauge(`${prefix}.gc.major.max_ms`)
      const gcP99 = meter.createObservableGauge(`${prefix}.gc.major.p99_ms`)

      meter.addBatchObservableCallback(
        (observer) => {
          const stats = this._gcStats
          observer.observe(gcCount, stats.count)
          observer.observe(
            gcAvg,
            stats.count > 0 ? stats.totalMs / stats.count : 0,
          )
          observer.observe(gcMax, stats.maxMs)

          if (stats.durations.length > 0) {
            const sorted = stats.durations.slice().sort((a, b) => a - b)
            const idx = Math.min(
              Math.ceil(sorted.length * 0.99) - 1,
              sorted.length - 1,
            )
            observer.observe(gcP99, sorted[idx])
          } else {
            observer.observe(gcP99, 0)
          }

          // Reset for next interval
          this._gcStats = { count: 0, totalMs: 0, maxMs: 0, durations: [] }
        },
        [gcCount, gcAvg, gcMax, gcP99],
      )
    }

    // Handles & Requests
    if (enable.handlesRequests !== false) {
      const handles = meter.createObservableGauge(`${prefix}.handles`)
      const requests = meter.createObservableGauge(`${prefix}.requests`)

      meter.addBatchObservableCallback(
        (observer) => {
          observer.observe(
            handles,
            (process as any)._getActiveHandles?.()?.length ?? 0,
          )
          observer.observe(
            requests,
            (process as any)._getActiveRequests?.()?.length ?? 0,
          )
        },
        [handles, requests],
      )
    }

    // CPU
    if (enable.cpu !== false) {
      this._prevCpuUsage = process.cpuUsage()
      this._prevCpuTime = Date.now()

      const cpuUser = meter.createObservableGauge(`${prefix}.cpu.user_pct`)
      const cpuSystem = meter.createObservableGauge(`${prefix}.cpu.system_pct`)
      const cpuTotal = meter.createObservableGauge(`${prefix}.cpu.total_pct`)

      meter.addBatchObservableCallback(
        (observer) => {
          const now = Date.now()
          const elapsed = now - this._prevCpuTime
          if (elapsed <= 0) return

          const current = process.cpuUsage()
          const prev = this._prevCpuUsage
          if (!prev) return
          const userDelta = current.user - prev.user
          const systemDelta = current.system - prev.system
          // cpuUsage returns microseconds, elapsed is milliseconds
          const elapsedMicros = elapsed * 1000
          const userPct = (userDelta / elapsedMicros) * 100
          const systemPct = (systemDelta / elapsedMicros) * 100

          observer.observe(cpuUser, userPct)
          observer.observe(cpuSystem, systemPct)
          observer.observe(cpuTotal, userPct + systemPct)

          this._prevCpuUsage = current
          this._prevCpuTime = now
        },
        [cpuUser, cpuSystem, cpuTotal],
      )
    }

    // Memory (RSS, external, arrayBuffers)
    if (enable.memory !== false) {
      const rss = meter.createObservableGauge(`${prefix}.memory.rss_mb`)
      const external = meter.createObservableGauge(
        `${prefix}.memory.external_mb`,
      )
      const arrayBuffers = meter.createObservableGauge(
        `${prefix}.memory.array_buffers_mb`,
      )

      meter.addBatchObservableCallback(
        (observer) => {
          const mem = process.memoryUsage()
          observer.observe(rss, mem.rss / (1024 * 1024))
          observer.observe(external, mem.external / (1024 * 1024))
          observer.observe(arrayBuffers, mem.arrayBuffers / (1024 * 1024))
        },
        [rss, external, arrayBuffers],
      )
    }
  }

  stop(): void {
    if (!this._started) return
    this._started = false

    if (this._histogram) {
      this._histogram.disable()
      this._histogram = null
    }

    if (this._gcObserver) {
      this._gcObserver.disconnect()
      this._gcObserver = null
    }

    this._prevCpuUsage = null
    this._gcStats = { count: 0, totalMs: 0, maxMs: 0, durations: [] }
  }
}
