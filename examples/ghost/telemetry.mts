import fs from 'fs'
import path from 'path'
import { honeycombInit, SpanStatusCode } from 'opinionated-telemetry/honeycomb'
import { otelInitKnex } from 'opinionated-telemetry/integrations/knex'
import { createAutoInstrumentHookCJS } from 'opinionated-telemetry/auto-instrument'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

// Kind of annoying that this is an enum rather than just a normal string union
import { ExpressLayerType } from '@opentelemetry/instrumentation-express'

const { shutdown } = honeycombInit({
  serviceName: 'ghost',
  apiKey: process.env.HC_API_KEY!,
  instrumentations: getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-express': {
      ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
    },
  }),
  instrumentationHooks: {
    '@opentelemetry/instrumentation-knex': {
      onStart(span) {
        span.updateName(`knex:${span.name.split(' ')[0] ?? 'unknown'}`)
      },
    },
  },
  globalHooks: {
    onStart(span) {
      // Don't worry about capturing the low level networking details unless it's slow or erroring
      if (/-(net|dns|tcp)/.test(span.instrumentationScope?.name ?? '')) {
        return {
          shouldDrop(span, durationMs) {
            return span.status.code !== SpanStatusCode.ERROR &&
              durationMs < 1000
              ? 'drop'
              : false
          },
        }
      }
    },
  },
})

const ghostPath = fs.realpathSync(
  path.join(import.meta.dirname, 'ghost-app/current'),
  'utf8',
)

// Add some auto instrumentation to various functions in the core services layer
createAutoInstrumentHookCJS({
  instrumentPaths: [
    {
      base: ghostPath,
      dirs: ['core/server/services'],
    },
  ],

  classInstrumentation: {
    includeClass(className, ClassObj, filename) {
      if (filename.includes('/errors/')) {
        return false
      }
      return true
    },
    includeMethod(methodName, className, method, filename) {
      return true
    },
  },

  hooks: {
    onStart(span, context) {
      //
    },
    onEnd(span, context) {
      //
    },
  },
})

function shutdownOtel() {
  shutdown().catch(console.error)
}

process.on('SIGINT', shutdownOtel)
process.on('SIGTERM', shutdownOtel)

// Allow the app to startup, then wire up our otelInitKnex helper
process.nextTick(() => {
  import(`${ghostPath}/core/server/data/db/index.js`).then((val) => {
    otelInitKnex(val.default.knex)
  })
})
