import { trace, SpanStatusCode, SpanKind, type Link } from '@opentelemetry/api'
import debugLib from 'debug'

const debug = debugLib('opin-tel:bull')

export interface BullOtelConfig {
  /** Tracer name. Default: 'bull-otel' */
  tracerName?: string
  /** Events to trace on .on(). Default: ['completed', 'stalled', 'failed', 'waiting'] */
  tracedEvents?: string[]
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
  const tracerName = config?.tracerName ?? 'bull-otel'
  const tracedEvents = config?.tracedEvents
    ? new Set(config.tracedEvents)
    : DEFAULT_TRACED_EVENTS
  const tracer = trace.getTracer(tracerName)

  debug('patching Bull.prototype (process, add, on)')

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
        const links: Link[] = []
        const otelLink = bullJob.data?.__otelLink
        if (otelLink) {
          links.push({
            context: {
              traceId: otelLink.traceId,
              spanId: otelLink.spanId,
              traceFlags: otelLink.traceFlags ?? 1,
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
              'bull.queue.name': bullJob.queue?.name || 'unknown',
              'bull.job.attempts': bullJob.attemptsMade,
            })

            try {
              const result = await processorFn(bullJob)
              span.end()
              return result
            } catch (err: any) {
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

  Bull.prototype.add = function patchedAdd(
    this: any,
    name: any,
    data: any,
    opts: any,
  ) {
    const currentSpan = trace.getActiveSpan()
    const link = currentSpan
      ? {
          traceId: currentSpan.spanContext().traceId,
          spanId: currentSpan.spanContext().spanId,
          traceFlags: currentSpan.spanContext().traceFlags,
        }
      : undefined

    if (typeof name === 'string') {
      return originalAdd.call(this, name, { ...data, __otelLink: link }, opts)
    }
    return originalAdd.call(this, { ...name, __otelLink: link }, data)
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
                message: err.message,
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
