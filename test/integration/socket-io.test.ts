import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { metrics, propagation } from '@opentelemetry/api'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import {
  otelPatchSocketIo,
  otelInitSocketIo,
} from '../../src/integrations/socket-io.js'
import { cleanupOtel, setupOtel } from '../helpers.js'

describe('otelInitSocketIo', () => {
  afterEach(() => cleanupOtel())

  it('creates an observable gauge for open connections', () => {
    setupOtel()
    const mockIo = { engine: { clientsCount: 5 } }

    // otelInitSocketIo just sets up the gauge — it shouldn't throw
    expect(() => otelInitSocketIo(mockIo)).not.toThrow()
  })

  it('uses custom meter name', () => {
    setupOtel()
    const mockIo = { engine: { clientsCount: 3 } }
    expect(() =>
      otelInitSocketIo(mockIo, { meterName: 'custom-meter' }),
    ).not.toThrow()
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
