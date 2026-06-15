import { metrics, type Meter } from '@opentelemetry/api'
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
  constants as perfConstants,
  type IntervalHistogram,
} from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

const MIB = 1024 * 1024 // bytes per mebibyte (binary) — values labelled MiB

// Explicit histogram bucket boundaries scaled per metric. OTel's defaults
// ([0,5,10,…,10000]) are tuned for second-scale HTTP latency and fit these
// poorly — e.g. ELU's 0-1 values would all land in one default bucket, leaving
// percentiles meaningless. Override via OTel Views if these don't suit you.
const GC_MS_BUCKETS = [0.5, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000]
const MIB_BUCKETS = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192]
const HEAP_PCT_BUCKETS = [10, 25, 50, 60, 70, 75, 80, 85, 90, 95, 98]
const CPU_PCT_BUCKETS = [1, 5, 10, 25, 50, 75, 100, 150, 200, 400] // >100 on multicore
const RATIO_BUCKETS = [
  0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99,
]

export interface NodeRuntimeMetricsConfig {
  /** Meter instance to use. Default: metrics.getMeter('opin_tel.runtime') */
  meter?: Meter
  /** Metric name prefix. Default: 'node' */
  prefix?: string
  /** Event loop delay monitor resolution in ms. Default: 20 */
  eventLoopDelayResolution?: number
  /**
   * How often (ms) to sample heap/memory/CPU/event-loop-utilization into their
   * histograms. Sub-interval sampling is what lets the backend see intra-interval
   * peaks (a once-per-export gauge would miss them) and keeps these metrics off
   * the collection callback, so they're safe with multiple readers. Default: 2000.
   */
  sampleIntervalMs?: number
  /** Selectively enable/disable metric groups. All default true. */
  enable?: {
    eventLoopDelay?: boolean
    eventLoopUtilization?: boolean
    heap?: boolean
    gc?: boolean
    activeResources?: boolean
    cpu?: boolean
    memory?: boolean
  }
}

export class NodeRuntimeMetrics {
  private _config: NodeRuntimeMetricsConfig
  private _started = false
  private _histogram: IntervalHistogram | null = null
  private _gcObserver: PerformanceObserver | null = null
  private _sampleTimer: NodeJS.Timeout | null = null

  constructor(config: NodeRuntimeMetricsConfig = {}) {
    this._config = config
  }

  start(): void {
    if (this._started) return
    this._started = true

    const meter = this._config.meter ?? metrics.getMeter('opin_tel.runtime')
    const prefix = this._config.prefix ?? 'node'
    const enable = this._config.enable ?? {}

    const makeHist = (
      name: string,
      unit: string,
      boundaries: number[],
      description?: string,
    ) =>
      meter.createHistogram(name, {
        unit,
        description,
        advice: { explicitBucketBoundaries: boundaries },
      })

    // Event Loop Delay
    if (enable.eventLoopDelay !== false) {
      this._histogram = monitorEventLoopDelay({
        resolution: this._config.eventLoopDelayResolution ?? 20,
      })
      this._histogram.enable()

      const eldP50 = meter.createObservableGauge(
        `${prefix}.eventloop.delay.p50`,
        {
          unit: 'ms',
          description: 'Event loop delay, 50th percentile per interval',
        },
      )
      const eldP99 = meter.createObservableGauge(
        `${prefix}.eventloop.delay.p99`,
        {
          unit: 'ms',
          description: 'Event loop delay, 99th percentile per interval',
        },
      )
      const eldMax = meter.createObservableGauge(
        `${prefix}.eventloop.delay.max`,
        { unit: 'ms', description: 'Event loop delay, maximum per interval' },
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

    // CPU, event-loop-utilization, heap, and memory are all recorded by the
    // sub-interval sampler below (see "Sampled metrics").

    // GC (major pauses only) — record each pause into a native histogram so
    // the backend derives count/avg/max/percentiles from the full distribution.
    if (enable.gc !== false) {
      const gcDuration = makeHist(
        `${prefix}.gc.major.duration`,
        'ms',
        GC_MS_BUCKETS,
        'Major (mark-sweep-compact) GC pause durations',
      )

      this._gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            (entry as any).detail?.kind ===
            perfConstants.NODE_PERFORMANCE_GC_MAJOR
          ) {
            gcDuration.record(entry.duration)
          }
        }
      })
      this._gcObserver.observe({ type: 'gc', buffered: true })
    }

    // Active resources keeping the event loop alive, counted by type
    // (Timeout, TCPSocketWrap, …) via the stable process.getActiveResourcesInfo().
    // Emits nothing when the loop has no ref'd resources — which is honest.
    if (enable.activeResources !== false) {
      const activeResources = meter.createObservableGauge(
        `${prefix}.active_resources`,
        {
          description:
            'Active resources keeping the event loop alive, counted by type',
        },
      )

      meter.addBatchObservableCallback(
        (observer) => {
          const counts = new Map<string, number>()
          for (const type of process.getActiveResourcesInfo()) {
            counts.set(type, (counts.get(type) ?? 0) + 1)
          }
          for (const [type, count] of counts) {
            observer.observe(activeResources, count, { 'resource.type': type })
          }
        },
        [activeResources],
      )
    }

    // ── Sampled metrics (heap, memory, CPU, event-loop utilization) ──
    //
    // Recorded into histograms by a sub-interval timer rather than at collection
    // time. Two wins: (1) the backend sees intra-interval peaks/distribution that
    // a once-per-60s snapshot would miss; (2) nothing mutates state inside a
    // metric-collection callback, so these stay correct with multiple readers.
    //
    // Heap/memory are stateless reads, so they're seeded immediately (so the
    // metric exists before the first tick). CPU/ELU are interval deltas, so their
    // baseline is set here and the first value lands on the first tick.
    const heapEnabled = enable.heap !== false
    const memoryEnabled = enable.memory !== false
    const cpuEnabled = enable.cpu !== false
    const eluEnabled = enable.eventLoopUtilization !== false

    if (heapEnabled || memoryEnabled || cpuEnabled || eluEnabled) {
      const intervalRecorders: Array<() => void> = []

      if (heapEnabled || memoryEnabled) {
        // The V8 heap limit is fixed at startup, so read it once. used_pct is
        // measured against it (distance to the OOM ceiling), not against
        // heapTotal (which itself grows toward the limit).
        const heapLimit = getHeapStatistics().heap_size_limit
        const heapUsed = heapEnabled
          ? makeHist(
              `${prefix}.heap.used_mib`,
              'MiB',
              MIB_BUCKETS,
              'V8 heap used',
            )
          : null
        const heapTotal = heapEnabled
          ? makeHist(
              `${prefix}.heap.total_mib`,
              'MiB',
              MIB_BUCKETS,
              'V8 heap allocated',
            )
          : null
        const heapPct = heapEnabled
          ? makeHist(
              `${prefix}.heap.used_pct`,
              '%',
              HEAP_PCT_BUCKETS,
              'Heap used as a percentage of the V8 heap size limit',
            )
          : null
        const rss = memoryEnabled
          ? makeHist(
              `${prefix}.memory.rss_mib`,
              'MiB',
              MIB_BUCKETS,
              'Resident set size (total process memory)',
            )
          : null
        const external = memoryEnabled
          ? makeHist(
              `${prefix}.memory.external_mib`,
              'MiB',
              MIB_BUCKETS,
              'Memory used by C++ objects bound to JS values',
            )
          : null
        const arrayBuffers = memoryEnabled
          ? makeHist(
              `${prefix}.memory.array_buffers_mib`,
              'MiB',
              MIB_BUCKETS,
              'Memory allocated for ArrayBuffers / SharedArrayBuffers',
            )
          : null

        const recordMemory = () => {
          const mem = process.memoryUsage()
          heapUsed?.record(mem.heapUsed / MIB)
          heapTotal?.record(mem.heapTotal / MIB)
          heapPct?.record(heapLimit > 0 ? (mem.heapUsed / heapLimit) * 100 : 0)
          rss?.record(mem.rss / MIB)
          external?.record(mem.external / MIB)
          arrayBuffers?.record(mem.arrayBuffers / MIB)
        }

        recordMemory() // seed immediately — stateless, no baseline needed
        intervalRecorders.push(recordMemory)
      }

      if (cpuEnabled) {
        const cpuUser = makeHist(
          `${prefix}.cpu.user_pct`,
          '%',
          CPU_PCT_BUCKETS,
          'Process CPU time in user space (% of wall time; >100% on multicore)',
        )
        const cpuSystem = makeHist(
          `${prefix}.cpu.system_pct`,
          '%',
          CPU_PCT_BUCKETS,
          'Process CPU time in kernel space (% of wall time)',
        )
        const cpuTotal = makeHist(
          `${prefix}.cpu.total_pct`,
          '%',
          CPU_PCT_BUCKETS,
          'Process CPU time, user + system (% of wall time)',
        )
        let prevCpu = process.cpuUsage()
        let prevTime = performance.now()
        intervalRecorders.push(() => {
          const now = performance.now()
          const elapsedMs = now - prevTime
          if (elapsedMs <= 0) return
          const cur = process.cpuUsage()
          // cpuUsage is microseconds; elapsedMs is milliseconds
          const userPct = ((cur.user - prevCpu.user) / 1000 / elapsedMs) * 100
          const systemPct =
            ((cur.system - prevCpu.system) / 1000 / elapsedMs) * 100
          cpuUser.record(userPct)
          cpuSystem.record(systemPct)
          cpuTotal.record(userPct + systemPct)
          prevCpu = cur
          prevTime = now
        })
      }

      if (eluEnabled) {
        const eluHist = makeHist(
          `${prefix}.eventloop.utilization`,
          '1',
          RATIO_BUCKETS,
          'Event loop utilization (0-1 fraction active, per interval)',
        )
        let prevElu = performance.eventLoopUtilization()
        intervalRecorders.push(() => {
          const current = performance.eventLoopUtilization()
          eluHist.record(
            performance.eventLoopUtilization(current, prevElu).utilization,
          )
          prevElu = current
        })
      }

      this._sampleTimer = setInterval(() => {
        for (const record of intervalRecorders) record()
      }, this._config.sampleIntervalMs ?? 2000)
      this._sampleTimer.unref()
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

    if (this._sampleTimer) {
      clearInterval(this._sampleTimer)
      this._sampleTimer = null
    }
  }
}
