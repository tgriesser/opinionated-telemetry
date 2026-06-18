import {
  trace,
  metrics,
  SpanStatusCode,
  SpanKind,
  type Link,
  type Counter,
  type Histogram,
} from '@opentelemetry/api'
import { performance } from 'node:perf_hooks'
import debugLib from 'debug'

const debug = debugLib('opin_tel:bull')

export interface BullOtelConfig {
  /** Tracer name. Default: 'bull-otel' */
  tracerName?: string
  /** Events to trace on .on(). Default: ['completed', 'stalled', 'failed', 'waiting'] */
  tracedEvents?: string[]
  /** Meter name for queue metrics. Default: 'bull-otel' */
  meterName?: string
  /** Emit queue depth/throughput/duration metrics. Default: true */
  metrics?: boolean
  /**
   * Whether to add the __otelLink to the payload to link bull jobs w/ traces
   * @default {true}
   */
  addJobLink?: boolean
}

const DEFAULT_TRACED_EVENTS = new Set([
  'completed',
  'stalled',
  'failed',
  'waiting',
])

/**
 * Patches Bull.prototype.process, .add, and .on with OTel tracing.
 * Call before any queues are created. Pass the Bull constructor.
 *
 * .add() captures the current span context and stores it in the job data.
 * .process() creates a new root span with a span link back to the enqueuing
 * span, so the two traces are connected without creating an artificially
 * long parent-child trace.
 * .on() wraps async event handlers for lifecycle events with spans.
 */
export function otelInitBull(Bull: any, config?: BullOtelConfig): void {
  const addJobLink = Boolean(config?.addJobLink ?? true)
  const tracerName = config?.tracerName ?? 'bull-otel'
  const tracedEvents = config?.tracedEvents
    ? new Set(config.tracedEvents)
    : DEFAULT_TRACED_EVENTS
  const tracer = trace.getTracer(tracerName)

  debug('patching Bull.prototype (process, add, on)')

  // ── Queue metrics ──
  // Queue instances are registered as they're seen via patched add()/process(),
  // then a single async observable reports their depth. Throughput and duration
  // are recorded at the processing site below.
  const metricsEnabled = config?.metrics !== false
  const queues = new Set<any>()
  let jobsProcessed: Counter | undefined
  let jobDuration: Histogram | undefined

  if (metricsEnabled) {
    const meter = metrics.getMeter(config?.meterName ?? 'bull-otel')

    jobsProcessed = meter.createCounter('bull.jobs.processed', {
      description:
        'Bull job processing attempts, by queue and outcome (bull.job.status)',
    })
    jobDuration = meter.createHistogram('bull.job.duration', {
      unit: 'ms',
      description: 'Bull job processing duration, by queue',
    })

    // Backlog: current pending jobs by state. getJobCounts() is a Redis round-
    // trip, run once per collection per queue. completed/failed are intentionally
    // excluded here — those are trimmable set sizes, so throughput is the counter.
    const PENDING_STATES = ['waiting', 'active', 'delayed', 'paused'] as const
    meter
      .createObservableGauge('bull.queue.jobs', {
        description:
          'Pending Bull jobs by queue and state (waiting/active/delayed/paused)',
      })
      .addCallback(async (observer) => {
        for (const queue of queues) {
          try {
            const counts = await queue.getJobCounts()
            const name = queue.name ?? 'unknown'
            for (const state of PENDING_STATES) {
              observer.observe(counts?.[state] ?? 0, {
                'bull.queue.name': name,
                'bull.job.state': state,
              })
            }
          } catch {
            // queue may be closed/unavailable — skip it this cycle
          }
        }
      })
  }

  const originalProcess = Bull.prototype.process
  const originalAdd = Bull.prototype.add
  const originalOn = Bull.prototype.on

  Bull.prototype.process = function patchedProcess(this: any, ...args: any[]) {
    const processorIdx = args.findIndex((a: any) => typeof a === 'function')
    if (processorIdx !== -1) {
      const processorFn = args[processorIdx]
      const jobName =
        typeof args[0] === 'string' ? args[0] : this.name || 'unknown'

      args[processorIdx] = function tracedProcessor(bullJob: any) {
        const queueName = bullJob.queue?.name || 'unknown'
        if (metricsEnabled && bullJob.queue) queues.add(bullJob.queue)

        const links: Link[] = []
        const { __otelLink, ...originalJobData } = bullJob.data ?? {}
        if (__otelLink) {
          bullJob.data = originalJobData
          links.push({
            context: {
              traceId: __otelLink.traceId,
              spanId: __otelLink.spanId,
              traceFlags: __otelLink.traceFlags ?? 1,
            },
            attributes: { 'link.source': 'bull.add' },
          })
        }

        return tracer.startActiveSpan(
          `bull.process:${jobName}`,
          {
            kind: SpanKind.CONSUMER,
            links,
            root: true,
          },
          async (span) => {
            span.setAttributes({
              'bull.job.name': jobName,
              'bull.job.id': String(bullJob.id),
              'bull.queue.name': queueName,
              'bull.job.attempts': bullJob.attemptsMade,
            })

            const start = performance.now()
            try {
              const result = await processorFn(bullJob)
              jobDuration?.record(performance.now() - start, {
                'bull.queue.name': queueName,
              })
              jobsProcessed?.add(1, {
                'bull.queue.name': queueName,
                'bull.job.status': 'completed',
              })
              span.end()
              return result
            } catch (err: any) {
              jobDuration?.record(performance.now() - start, {
                'bull.queue.name': queueName,
              })
              jobsProcessed?.add(1, {
                'bull.queue.name': queueName,
                'bull.job.status': 'failed',
              })
              span.recordException(err)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err?.message,
              })
              span.end()
              throw err
            }
          },
        )
      }
    }
    return originalProcess.apply(this, args)
  }

  Bull.prototype.add = function patchedAdd(this: any, ...args: any[]) {
    if (metricsEnabled) queues.add(this)
    const currentSpan = trace.getActiveSpan()
    const link =
      currentSpan && addJobLink
        ? {
            __otelLink: {
              traceId: currentSpan.spanContext().traceId,
              spanId: currentSpan.spanContext().spanId,
              traceFlags: currentSpan.spanContext().traceFlags,
            },
          }
        : undefined

    if (typeof args[0] === 'string') {
      // add(name, data, opts?)
      const [name, data, opts] = args
      return originalAdd.call(this, name, { ...data, ...link }, opts)
    }
    // add(data, opts?)
    const [data, opts] = args
    return originalAdd.call(this, { ...data, ...link }, opts)
  }

  Bull.prototype.on = function patchedOn(
    this: any,
    event: string,
    handler: any,
  ) {
    if (
      tracedEvents.has(event) &&
      typeof handler === 'function' &&
      handler.constructor.name === 'AsyncFunction'
    ) {
      const queueName = this.name || 'unknown'
      const spanName = handler.name || `bull.on:${event}`
      const originalHandler = handler

      const wrappedHandler = function tracedEventHandler(
        this: any,
        ...args: any[]
      ) {
        return tracer.startActiveSpan(spanName, (span) => {
          span.setAttributes({
            'bull.event': event,
            'bull.queue.name': queueName,
          })
          return originalHandler.apply(this, args).then(
            (val: any) => {
              span.end()
              return val
            },
            (err: any) => {
              span.recordException(err)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err?.message,
              })
              span.end()
              throw err
            },
          )
        })
      }

      Object.defineProperty(wrappedHandler, 'length', {
        value: originalHandler.length,
        configurable: true,
      })

      return originalOn.call(this, event, wrappedHandler)
    }
    return originalOn.call(this, event, handler)
  }
}
