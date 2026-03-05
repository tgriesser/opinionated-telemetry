import { describe, it, expect, afterEach } from 'vitest'
import { propagation } from '@opentelemetry/api'
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  graphql,
  defaultFieldResolver,
} from 'graphql'
import { otelInitGraphql } from '../../src/integrations/graphql.js'
import { cleanupOtel, createSimpleProvider } from '../helpers.js'

describe('otelInitGraphql (real GraphQL)', () => {
  afterEach(() => cleanupOtel())

  it('wraps custom resolvers and propagates graphql attrs as baggage', async () => {
    const { tracer } = createSimpleProvider()

    let baggageSeen: Record<string, string | undefined> = {}

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: {
            type: GraphQLString,
            resolve: () => {
              const bag = propagation.getActiveBaggage()
              baggageSeen['graphql.operation.name'] = bag?.getEntry(
                'graphql.operation.name',
              )?.value
              return 'world'
            },
          },
        },
      }),
    })

    otelInitGraphql(schema, { fieldResolver: defaultFieldResolver })

    await tracer.startActiveSpan('graphql', (span) => {
      span.setAttribute('graphql.operation.name', 'TestQuery')
      const result = graphql({ schema, source: '{ hello }', contextValue: {} })
      span.end()
      return result
    })

    expect(baggageSeen['graphql.operation.name']).toBe('TestQuery')
  })

  it('skips default resolvers', async () => {
    const { tracer } = createSimpleProvider()

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          greeting: {
            type: GraphQLString,
            // No explicit resolve — uses defaultFieldResolver
          },
        },
      }),
    })

    otelInitGraphql(schema, { fieldResolver: defaultFieldResolver })

    await tracer.startActiveSpan('graphql', async (span) => {
      const result = await graphql({
        schema,
        source: '{ greeting }',
        rootValue: { greeting: 'hi' },
      })
      expect(result.data?.greeting).toBe('hi')
      span.end()
    })
  })

  it('wraps resolvers and preserves return values', async () => {
    const { tracer } = createSimpleProvider()

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          echo: {
            type: GraphQLString,
            args: {
              msg: { type: new GraphQLNonNull(GraphQLString) },
            },
            resolve: (_root, args) => args.msg,
          },
        },
      }),
    })

    otelInitGraphql(schema, { fieldResolver: defaultFieldResolver })

    const result = await tracer.startActiveSpan('graphql', async (span) => {
      const r = await graphql({
        schema,
        source: '{ echo(msg: "hello world") }',
      })
      span.end()
      return r
    })

    expect(result.data?.echo).toBe('hello world')
  })

  it('respects shouldWrapResolver to skip specific resolvers', async () => {
    const { tracer } = createSimpleProvider()

    let helloBaggageSeen = false
    let echoBaggageSeen = false

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: {
            type: GraphQLString,
            resolve: () => {
              const bag = propagation.getActiveBaggage()
              helloBaggageSeen = !!bag?.getEntry('graphql.operation.name')
              return 'world'
            },
          },
          echo: {
            type: GraphQLString,
            resolve: () => {
              const bag = propagation.getActiveBaggage()
              echoBaggageSeen = !!bag?.getEntry('graphql.operation.name')
              return 'echoed'
            },
          },
        },
      }),
    })

    otelInitGraphql(schema, {
      fieldResolver: defaultFieldResolver,
      shouldWrapResolver: ({ fieldName }) => fieldName === 'hello',
    })

    await tracer.startActiveSpan('graphql', async (span) => {
      span.setAttribute('graphql.operation.name', 'TestQuery')
      await graphql({ schema, source: '{ hello echo }' })
      span.end()
    })

    // hello was wrapped — should see baggage
    expect(helloBaggageSeen).toBe(true)
    // echo was skipped — should NOT see baggage
    expect(echoBaggageSeen).toBe(false)
  })
})
