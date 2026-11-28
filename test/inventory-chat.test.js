import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { BSON, ObjectId } from 'mongodb'
import { createApp } from '../server/app.js'
import { requireInventoryAccess } from '../server/auth.js'
import { openAIInventory } from '../server/openai-inventory.js'

const { EJSON } = BSON
const bson = value => EJSON.stringify(value, { relaxed: false })
const building = { _id: new ObjectId(), description: 'Oak Street', address: '12 Oak St' }
const unit = { _id: 'unit-3l', description: 'Unit 3L', label: '3L' }
const buildingLink = {
  _id: new ObjectId(), type: 'building_unit', description: 'Oak Street unit',
  endpointA: { collection: 'buildings', id: building._id },
  endpointB: { collection: 'units', id: unit._id },
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(condition => matches(document, condition))
    const actual = key.split('.').reduce((value, field) => value?.[field], document)
    if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual)
    if (Object.hasOwn(expected ?? {}, '$eq')) return bson(actual) === bson(expected.$eq)
    if (expected?.$type) return expected.$type === 'date' ? actual instanceof Date : actual instanceof ObjectId
    return bson(actual) === bson(expected)
  })
}

function inventoryFixture() {
  const state = new Map([
    ['buildings', [building]],
    ['units', [unit]],
    ['relationships', [buildingLink]],
    ['appliances', [{
      _id: new ObjectId(), description: 'Sample oven', type: 'oven', purchasedAt: new Date(),
      dimensions: { width: new BSON.Int32(30), depth: new BSON.Int32(24) }, receiptUrl: 'https://example.com/sample',
    }]],
  ])
  const indexes = []
  const db = {
    listCollections: ({ name, type } = {}) => ({
      toArray: async () => [...state.keys()].map(name => ({ name, type: 'collection' }))
        .filter(item => (!name || name === item.name) && (!type || type === item.type)),
    }),
    collection(name) {
      const documents = () => state.get(name) ?? []
      return {
        find(filter) {
          const results = documents().filter(document => matches(document, filter))
          return {
            limit(count) { results.splice(count); return this },
            toArray: async () => results,
            async *[Symbol.asyncIterator]() { yield* results },
          }
        },
        async findOne(filter) { return documents().find(document => matches(document, filter)) ?? null },
        async distinct(key) { return [...new Set(documents().map(document => document[key]))] },
        async insertOne(document) {
          state.set(name, [...documents(), document])
          return { insertedId: document._id }
        },
        async indexes() { return indexes.slice() },
        async createIndex(key, { unique } = {}) { indexes.push({ key, unique }) },
      }
    },
    client: {
      withSession: callback => callback({
        async withTransaction(operation) {
          const before = new Map(state)
          try { return await operation() } catch (error) {
            state.clear()
            for (const [name, records] of before) state.set(name, records)
            throw error
          }
        },
      }),
    },
  }
  return { db, state, indexes }
}

async function mockResponse(messages, invoke) {
  if (messages.at(-1).content === 'Add a microwave') return 'Which unit is the microwave for?'
  assert.deepEqual((await invoke('list_collections', {})).collections, ['appliances', 'buildings', 'units'])
  const inspected = await invoke('inspect_collection', { collection: 'appliances' })
  assert.equal(inspected.structure.dimensions.width, 'Int32')
  assert.ok(!JSON.stringify(inspected).includes('Sample oven'))
  const { matches: [target] } = await invoke('find_records', { collection: 'units', search: '3L' })
  assert.equal(target.buildings[0].description, 'Oak Street')
  const links = [{ type: 'property_unit', target: target.ref, description: 'Microwave in Unit 3L' }]
  assert.match((await invoke('propose_entry', {
    collection: 'appliances', fields: '{"description":" "}', links,
  })).error, /description/)
  assert.deepEqual(await invoke('propose_entry', {
    collection: 'appliances', fields: '{"description":"Microwave","type":"microwave","purchasedAt":"2026-11-27","dimensions":{"width":20}}', links,
  }), { draft: true })
  return null
}

async function start(app, context) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const send = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options)
  return {
    send,
    post: (suffix, body, user = 'alice') => send('/api/inventory-chat' + suffix, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(user && { Authorization: 'Bearer ' + user }) },
      body: JSON.stringify(body),
    }),
  }
}

test('chat clarifies, previews and atomically saves a linked record through createApp', async context => {
  const { db, state, indexes } = inventoryFixture()
  const authorize = requireInventoryAccess(async token => ({
    uid: token, email: token + '@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' },
  }), () => true)
  const { post, send } = await start(createApp(db, {
    authorize, inventoryChat: { key: 'fixture-key', respond: mockResponse },
  }), context)
  assert.equal((await send('/api/inventory-chat')).status, 401)
  assert.equal((await post('', { messages: [] })).status, 400)
  const first = { role: 'user', content: 'Add a microwave' }
  const question = await (await post('', { messages: [first] })).json()
  assert.equal(question.message, 'Which unit is the microwave for?')
  const messages = [first, { role: 'assistant', content: question.message }, { role: 'user', content: '3L at Oak Street' }]
  const preview = await post('', { messages })
  assert.equal(preview.status, 200)
  const { draft } = await preview.json()
  assert.equal(draft.collection, 'appliances')
  assert.equal(draft.fields.receiptUrl, null)
  assert.deepEqual(draft.fields.dimensions, { width: 20, depth: null })
  assert.equal(state.get('appliances').length, 1)
  assert.equal(state.get('relationships').length, 1)
  assert.equal((await post('/save', { token: draft.token }, 'bob')).status, 409)
  assert.equal((await post('/save', { token: 'A' + draft.token })).status, 409)

  const saved = await post('/save', { token: draft.token })
  assert.equal(saved.status, 200)
  const { record } = await saved.json()
  assert.equal(record.description, 'Microwave')
  const document = state.get('appliances').at(-1)
  assert.equal(document.purchasedAt.toISOString(), '2026-11-27T05:00:00.000Z')
  assert.ok(document.dimensions.width instanceof BSON.Int32)
  const [, unitLink, propertyLink] = state.get('relationships')
  assert.equal(unitLink.endpointB.id, unit._id)
  assert.equal(propertyLink.endpointB.id.toHexString(), building._id.toHexString())
  assert.equal(indexes.filter(index => index.unique).length, 1)
  const query = new URLSearchParams({ collection: record.collection, id: record.id, bsonId: record.bsonId })
  const loaded = await send('/api/record?' + query, { headers: { Authorization: 'Bearer alice' } })
  assert.equal((await loaded.json()).description, 'Microwave')
  assert.deepEqual((await (await post('/save', { token: draft.token })).json()).record, record)
  assert.equal(state.get('relationships').length, 3)
  const duplicate = await (await post('', { messages })).json()
  assert.equal((await post('/save', { token: duplicate.draft.token })).status, 409)
  assert.equal(state.get('appliances').length, 2)
})

test('a first record in a new category is created only when the draft is saved', async context => {
  const { db, state } = inventoryFixture()
  const { post } = await start(createApp(db, {
    inventoryChat: {
      key: 'fixture-key',
      async respond(_messages, invoke) {
        await invoke('list_collections', {})
        await invoke('inspect_collection', { collection: 'warranties' })
        return (await invoke('propose_entry', {
          collection: 'warranties', fields: '{"description":"Microwave warranty"}', links: [],
        })).error
      },
    },
  }), context)
  const { draft } = await (await post('', { messages: [{ role: 'user', content: 'Add a microwave warranty' }] })).json()
  assert.equal(state.has('warranties'), false)
  assert.equal((await post('/save', { token: draft.token })).status, 200)
  assert.equal(state.get('warranties')[0].description, 'Microwave warranty')
})

test('disabled chat reports its availability', async context => {
  const { db } = inventoryFixture()
  const { post, send } = await start(createApp(db, { inventoryChat: null }), context)
  assert.deepEqual(await (await send('/api/inventory-chat')).json(), { enabled: false })
  assert.equal((await post('', {})).status, 503)
})

test('Responses API sends the skill and returns function results in the following request', async context => {
  const call = { type: 'function_call', name: 'list_collections', call_id: 'call_1', arguments: '{}' }
  const model = context.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body)
    assert.match(request.instructions, /Real Estate Inventory Add Entry/)
    assert.equal(request.store, false)
    if (request.input.at(-1).type === 'function_call_output') {
      assert.equal(request.input.at(-1).call_id, call.call_id)
      assert.deepEqual(JSON.parse(request.input.at(-1).output), { collections: ['units'] })
      return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Which building?' }] }],
      })
    }
    return Response.json({ status: 'completed', output: [call] })
  })
  const respond = openAIInventory({ apiKey: 'test-key', model: 'test-model' })
  assert.equal(await respond([{ role: 'user', content: 'Add a unit' }], async name => {
    assert.equal(name, 'list_collections')
    return { collections: ['units'] }
  }), 'Which building?')
  assert.equal(model.mock.callCount(), 2)
})
