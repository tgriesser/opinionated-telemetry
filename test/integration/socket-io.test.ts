import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { metrics, propagation } from '@opentelemetry/api'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import {
  otelPatchSocketIo,
  otelInitSocketIo,
} from '../../src/integrations/socket-io.js'
import { cleanupOtel, setupOtel } from '../helpers.js'

describe('otelInitSocketIo', () => {
  afterEach(() => {
    metrics.disable()
    cleanupOtel()
  })

  it('creates an observable gauge for open connections', () => {
    setupOtel()
    const mockIo = { engine: { clientsCount: 5 }, on: () => {} }

    // otelInitSocketIo just sets up the gauge — it shouldn't throw
    expect(() => otelInitSocketIo(mockIo)).not.toThrow()
  })

  it('uses custom meter name', () => {
    setupOtel()
    const mockIo = { engine: { clientsCount: 3 }, on: () => {} }
    expect(() =>
      otelInitSocketIo(mockIo, { meterName: 'custom-meter' }),
    ).not.toThrow()
  })

  it('tracks peak connections via the .max watermark', async () => {
    setupOtel()
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    })
    const provider = new MeterProvider({ readers: [reader] })
    metrics.setGlobalMeterProvider(provider)

    let onConnection: () => void = () => {}
    const mockIo = {
      engine: { clientsCount: 2 },
      on: (event: string, cb: () => void) => {
        if (event === 'connection') onConnection = cb
      },
    }
    otelInitSocketIo(mockIo)

    // Spike to 10 (fires a connection event), then settle back to 3
    mockIo.engine.clientsCount = 10
    onConnection()
    mockIo.engine.clientsCount = 3

    await reader.forceFlush()
    const vals = new Map<string, number>()
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          vals.set(m.descriptor.name, m.dataPoints[0]?.value as number)
        }
      }
    }

    expect(vals.get('socket.io.open_connections')).toBe(3) // current
    expect(vals.get('socket.io.open_connections.max')).toBe(10) // peak caught

    await provider.shutdown()
  })
})

describe('otelPatchSocketIo (real Socket.IO)', () => {
  let httpServer: ReturnType<typeof createServer>
  let ioServer: Server
  let port: number

  afterEach(() => {
    cleanupOtel()
    if (ioServer) ioServer.close()
    if (httpServer) httpServer.close()
  })

  it('injects baggage into event handlers', async () => {
    setupOtel()
    httpServer = createServer()
    ioServer = new Server(httpServer)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as any).port
        resolve()
      })
    })

    let baggageSeen: string | undefined

    ioServer.on('connection', (socket) => {
      ;(socket as any).jwt = { id: 'user-99' }
      otelPatchSocketIo(socket, {
        getBaggage: (s) => ({ 'app.account.id': s.jwt?.id ?? '' }),
      })

      socket.on('test-event', () => {
        const bag = propagation.getActiveBaggage()
        baggageSeen = bag?.getEntry('app.account.id')?.value
        socket.emit('test-response', { received: true })
      })
    })

    const client = ioClient(`http://localhost:${port}`)

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.emit('test-event', { data: 'hello' })
      })
      client.on('test-response', () => {
        client.disconnect()
        resolve()
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(baggageSeen).toBe('user-99')
  })

  it('uses custom getBaggage function', async () => {
    setupOtel()
    httpServer = createServer()
    ioServer = new Server(httpServer)

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as any).port
        resolve()
      })
    })

    let baggageSeen: string | undefined

    ioServer.on('connection', (socket) => {
      ;(socket as any).data = { userId: 'custom-42' }
      otelPatchSocketIo(socket, {
        getBaggage: (s) => ({ 'app.user.id': s.data.userId }),
      })

      socket.on('action', () => {
        const bag = propagation.getActiveBaggage()
        baggageSeen = bag?.getEntry('app.user.id')?.value
        socket.emit('action-response')
      })
    })

    const client = ioClient(`http://localhost:${port}`)

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.emit('action')
      })
      client.on('action-response', () => {
        client.disconnect()
        resolve()
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(baggageSeen).toBe('custom-42')
  })
})
