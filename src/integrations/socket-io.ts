import { metrics } from '@opentelemetry/api'
import debugLib from 'debug'
import { withBaggage } from '../baggage.js'

const debug = debugLib('opin_tel:socket-io')

export interface SocketOtelConfig {
  /** Meter name. Default: 'socket-io-otel' */
  meterName?: string
}

export interface PatchSocketOtelConfig {
  /** Function to extract baggage entries from the socket. Required. */
  getBaggage: (socket: any) => Record<string, unknown>
}

/**
 * Sets up an observable gauge for open Socket.IO connections.
 */
export function otelInitSocketIo(io: any, config?: SocketOtelConfig): void {
  const meterName = config?.meterName ?? 'socket-io-otel'
  debug('setting up connection gauge (meter=%s)', meterName)
  const meter = metrics.getMeter(meterName)
  meter
    .createObservableGauge('socket.io.open_connections', {
      description: 'Number of open Socket.IO connections on this server',
    })
    .addCallback((gauge) => {
      gauge.observe(io.engine.clientsCount)
    })
}

/**
 * Patches a Socket.IO socket's .on() to inject baggage context
 * into all event handlers.
 */
export function otelPatchSocketIo(
  socket: any,
  config: PatchSocketOtelConfig,
): void {
  const { getBaggage } = config

  debug('patching socket.on for baggage injection')
  const originalOn = socket.on.bind(socket)
  socket.on = (event: string, handler: (...args: any[]) => any) => {
    return originalOn(event, (...args: any[]) => {
      return withBaggage(getBaggage(socket), () => handler(...args))
    })
  }
}
