import { randomUUID } from 'node:crypto'
import { BSON, ObjectId } from 'mongodb'

const { EJSON, Int32, Double, Long, Decimal128 } = BSON
const relationships = 'relationships'
const legacyLinks = new Set(['references', 'buildingId', 'unitId', 'propertyId', 'initialInspectionId'])
const labels = ['description', 'name', 'label', 'address', 'tenantName', 'type']
const namePattern = /^[a-z][a-z0-9_-]{0,79}$/i
const propertyTargets = new Map([
  ['building_unit', 'buildings'], ['property_building', 'buildings'], ['property_unit', 'units'],
])
const easternOffset = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', timeZoneName: 'longOffset',
})
const readBson = { promoteValues: false }
const canonical = value => EJSON.stringify(value, { relaxed: false })
const endpointKey = ({ collection, id }) => canonical([collection, id])
const idFilter = id => ({ _id: { $eq: id } })
const isObject = value => value && Object.getPrototypeOf(value) === Object.prototype
const isText = (value, limit = 240) => typeof value === 'string' && !!value.trim() && value.length <= limit
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class EntryError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function collectionName(name) {
  if (!namePattern.test(name ?? '') || typeof name !== 'string' || name.toLowerCase() === relationships) {
    throw new EntryError('Choose a valid inventory collection.')
  }
  return name
}

async function listCollections(db) {
  const list = await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()
  return list.map(item => item.name).filter(name => namePattern.test(name) && name.toLowerCase() !== relationships).sort()
}

function publicRecord(collection, { _id, ...fields }) {
  return {
    collection, id: String(_id),
    ...(typeof _id !== 'string' && { bsonId: canonical(_id) }),
    description: labels.map(key => fields[key]).find(value => isText(value, 1024)) ?? String(_id),
  }
}

function projection() {
  return Object.fromEntries(labels.map(key => [key, 1]))
}

function linkQuery(endpoint, side) {
  return { [`endpoint${side}.collection`]: endpoint.collection, [`endpoint${side}.id`]: { $eq: endpoint.id } }
}

async function unitBuildings(db, id, session) {
  const unit = { collection: 'units', id }
  const links = await db.collection(relationships).find({
    type: 'building_unit', $or: [linkQuery(unit, 'A'), linkQuery(unit, 'B')],
  }, { ...readBson, session }).limit(20).toArray()
  const buildings = new Map()
  for (const { endpointA, endpointB } of links) {
    if (!endpointA || !endpointB) continue
    const other = endpointKey(endpointA) === endpointKey(unit) ? endpointB : endpointA
    if (other.collection !== 'buildings') continue
    const record = await db.collection('buildings').findOne(idFilter(other.id), { ...readBson, session, projection: projection() })
    if (record) buildings.set(endpointKey(other), record)
  }
  return [...buildings.values()]
}

async function inspect(db, collection) {
  const [info] = await db.listCollections({ name: collection }, { nameOnly: false }).toArray()
  if (info && info.type !== 'collection') throw new EntryError('Choose a collection that accepts new records.')
  const records = db.collection(collection)
  let sample
  if (info) {
    for (const field of ['createdAt', 'created_at']) {
      sample = await records.findOne({ [field]: { $type: 'date' } }, { ...readBson, sort: { [field]: -1, _id: -1 } })
      if (sample) break
    }
    sample ??= await records.findOne({ _id: { $type: 'objectId' } }, { ...readBson, sort: { _id: -1 } })
    if (!sample) {
      const examples = await records.find({}, readBson).limit(2).toArray()
      if (examples.length === 1) [sample] = examples
    }
  }
  return { template: sample ?? {}, validator: info?.options?.validator ?? null }
}

function shape(value, depth = 0) {
  if (depth > 16) return 'unknown'
  if (value instanceof Date) return 'date'
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : []
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, shape(field, depth + 1)]))
  return value === null ? 'unknown' : value?._bsontype ?? typeof value
}

function normalize(value, template, depth = 0) {
  if (depth > 16) throw new EntryError('Use fewer levels of nested fields.')
  if (value == null && (!isObject(template) || Object.hasOwn(template, 'description'))) return null
  if (Array.isArray(value) && (template == null || Array.isArray(template))) {
    return value.map(item => normalize(item, template?.[0], depth + 1))
  }

  if (isObject(value) || (value == null && isObject(template))) {
    if (template != null && !isObject(template)) throw new EntryError('Use the types shown by the collection template.')
    const entries = Object.entries(value ?? {})
    if (entries.some(([key]) => !key || /[.$\0]/.test(key) ||
        ['__proto__', 'constructor', 'prototype', '_id', '_bsontype', 'toBSON'].includes(key))) {
      throw new EntryError('Use plain inventory field names and omit internal IDs.')
    }
    const fields = { ...(isObject(template) ? template : {}), ...value }
    return Object.fromEntries(Object.keys(fields).map(key => [
      key, normalize(value && Object.hasOwn(value, key) ? value[key] : null, template?.[key], depth + 1),
    ]))
  }
  if (value == null) return null
  try {
    if (template instanceof Date) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new Error()
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error()
      if (value.length === 10) {
        const offset = easternOffset.formatToParts(date).find(part => part.type === 'timeZoneName').value.slice(3)
        return new Date(value + 'T00:00:00' + offset)
      }
      return date
    }
    if (template instanceof Int32 && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return new Int32(value)
    if (template instanceof Double && Number.isFinite(value)) return new Double(value)
    if (template instanceof Long && (Number.isSafeInteger(value) || /^-?\d+$/.test(value))) return Long.fromStringStrict(String(value))
    if (template instanceof Decimal128 && ['string', 'number'].includes(typeof value)) return Decimal128.fromString(String(value))
  } catch {
    throw new EntryError('Use a valid value of the type shown by the collection template.')
  }
  if (template != null && (typeof value !== typeof template || typeof template === 'object')) {
    throw new EntryError('Use the types shown by the collection template.')
  }
  return value
}

function assertDescriptions(value) {
  if (Array.isArray(value)) {
    value.forEach(assertDescriptions)
  } else if (isObject(value)) {
    if (Object.hasOwn(value, 'description') && !isText(value.description, 500)) {
      throw new EntryError('Every entry and embedded entity needs a non-blank description.')
    }
    Object.values(value).forEach(assertDescriptions)
  }
}

function makeRelationship(source, target, type, description) {
  const [endpointA, endpointB] = [source, target].sort((a, b) => (
    endpointKey(a) < endpointKey(b) ? -1 : 1
  ))
  return { _id: new ObjectId(), type, description: description.trim(), endpointA, endpointB }
}

export function entryTools(db) {
  const inspected = new Map()
  const matches = []
  let listed = false
  let draft

  function reference(collection, record) {
    matches.push({ collection, record })
    return { ref: matches.length, ...Object.fromEntries(labels.flatMap(key => (
      isText(record[key], 1024) ? [[key, record[key]]] : []
    ))) }
  }

  async function findRecords(collection, search) {
    if (!isText(search, 120) || !(await listCollections(db)).includes(collection)) {
      throw new EntryError('Provide a search term and an existing collection.')
    }
    const term = search.trim()
    const regex = new RegExp(escapeRegex(term), 'i')
    const records = await db.collection(collection).find({
      $or: [{ _id: term }, ...labels.map(key => ({ [key]: regex })), ...(/^[\da-f]{24}$/i.test(term) ? [{ _id: new ObjectId(term) }] : [])],
    }, { ...readBson, projection: projection(), maxTimeMS: 4000 }).limit(9).toArray()
    const results = []
    for (const record of records.slice(0, 8)) {
      const match = reference(collection, record)
      if (collection === 'units') match.buildings = (await unitBuildings(db, record._id)).map(building => reference('buildings', building))
      results.push(match)
    }
    return { matches: results, more: records.length > 8 }
  }

  async function propose(collection, fields, links) {
    if (!listed) throw new EntryError('Check the list of inventory collections first.')
    if (!inspected.has(collection)) throw new EntryError('Inspect the destination collection first.')
    if (typeof fields !== 'string' || fields.length > 9000 || !Array.isArray(links) || links.length > 10) {
      throw new EntryError('Provide one entry with up to ten links.')
    }
    let known
    try { known = JSON.parse(fields) } catch { throw new EntryError('Provide the known fields as a JSON object.') }
    if (!isObject(known) || !isText(known.description, 500) || Object.hasOwn(known, '_id')) {
      throw new EntryError('Provide a non-blank description and omit the record ID.')
    }

    const { template } = inspected.get(collection)
    const related = new Map()
    function addLink({ collection: targetCollection, record }, type, description) {
      const key = canonical([targetCollection, record._id, type])
      related.set(key, { collection: targetCollection, record, type, description })
    }
    for (const link of links) {
      const { target, type, description } = link ?? {}
      const match = Number.isInteger(target) && matches[target - 1]
      if (!match || !isText(type, 80) || !namePattern.test(type) || !isText(description, 500)) {
        throw new EntryError('Use a verified target, relationship type and non-blank link description.')
      }
      const expected = propertyTargets.get(type)
      if ((expected && match.collection !== expected) || (type === 'building_unit' && collection !== 'units')) {
        throw new EntryError('Use the relationship type that matches the target collection.')
      }
      addLink(match, type, description)
    }
    const unitLinks = [...related.values()].filter(link => link.type === 'property_unit')
    for (const { record } of unitLinks) {
      const buildings = await unitBuildings(db, record._id)
      if (buildings.length !== 1) throw new EntryError('This unit needs one verified building before linking a record to it.')
      const [building] = buildings
      const supplied = [...related.values()].filter(link => link.type === 'property_building')
      if (supplied.some(link => canonical(link.record._id) !== canonical(building._id))) {
        throw new EntryError('The specified building does not match the unit’s building.')
      }
      if (!supplied.length) addLink({ collection: 'buildings', record: building }, 'property_building', 'Building for the linked unit')
    }
    if (collection === 'units' && [...related.values()].filter(link => link.type === 'building_unit').length !== 1) {
      throw new EntryError('Link the new unit to one verified building.')
    }
    const skip = key => key === '_id' || key === 'references' || (related.size && legacyLinks.has(key))
    const omitLinks = object => Object.fromEntries(Object.entries(object).filter(([key]) => !skip(key)))
    known.description = known.description.trim()
    const fieldsToSave = normalize(omitLinks(known), omitLinks(template))
    assertDescriptions(fieldsToSave)
    const id = typeof template._id === 'string' ? randomUUID() : new ObjectId()
    const source = { collection, id }
    const targets = [...related.values()]
    draft = {
      collection, document: { _id: id, ...fieldsToSave },
      identity: Object.fromEntries(Object.keys(omitLinks(known)).filter(key => fieldsToSave[key] != null)
        .map(key => [key, fieldsToSave[key]])),
      links: targets.map(target => makeRelationship(source, {
        collection: target.collection, id: target.record._id,
      }, target.type, target.description)),
      targets: targets.map(target => publicRecord(target.collection, target.record)),
    }
    return { draft: true }
  }

  return {
    get draft() { return draft },
    async invoke(name, args) {
      try {
        if (name === 'list_collections') {
          const collections = await listCollections(db)
          listed = true
          return { collections }
        }
        const collection = collectionName(args.collection)
        if (name === 'find_records') return await findRecords(collection, args.search)
        if (name === 'inspect_collection') {
          const result = await inspect(db, collection)
          inspected.set(collection, result)
          const types = await db.collection(relationships).distinct('type')
          return { structure: shape(result.template), validator: EJSON.serialize(result.validator), relationshipTypes: types }
        }
        if (name === 'propose_entry') return await propose(collection, args.fields, args.links)
        throw new EntryError('Unknown inventory action.')
      } catch (error) {
        if (error instanceof EntryError) return { error: error.message }
        throw error
      }
    },
  }
}

export function previewEntry({ collection, document, links, targets }) {
  const { _id, ...fields } = document
  return {
    collection,
    fields: EJSON.serialize(fields),
    links: links.map(({ type, description }, index) => ({ type, description, target: targets[index] })),
  }
}

async function ensureRelationshipIndexes(records) {
  const first = { 'endpointA.collection': 1, 'endpointA.id': 1 }
  const second = { 'endpointB.collection': 1, 'endpointB.id': 1 }
  const pair = { ...first, ...second, type: 1 }
  let existing
  try { existing = await records.indexes() } catch (error) {
    if (error.code !== 26) throw error
    existing = []
  }
  const keys = index => Object.keys(index.key)
  const supports = prefix => existing.some(index => !index.partialFilterExpression && !index.sparse &&
    Object.keys(prefix).every((key, indexPosition) => keys(index)[indexPosition] === key))
  if (!existing.some(index => index.unique && !index.partialFilterExpression && !index.sparse &&
      keys(index).length === 5 && keys(index).every(key => Object.hasOwn(pair, key)))) {
    await records.createIndex(pair, { unique: true })
  } else if (!supports(first)) {
    await records.createIndex(first)
  }
  if (!supports(second)) await records.createIndex(second)
}

function otherEndpoint(link, source) {
  return endpointKey(link.endpointA) === endpointKey(source) ? link.endpointB : link.endpointA
}

function matchingLink(link, source, other) {
  return {
    type: link.type,
    $or: [
      { ...linkQuery(source, 'A'), ...linkQuery(other, 'B') },
      { ...linkQuery(other, 'A'), ...linkQuery(source, 'B') },
    ],
  }
}

export async function saveEntry(db, { collection, document, identity, links }) {
  assertDescriptions(document)
  links.forEach(assertDescriptions)
  const records = db.collection(collection)
  const relationshipsCollection = db.collection(relationships)
  if (links.length) await ensureRelationshipIndexes(relationshipsCollection)
  const source = { collection, id: document._id }
  return db.client.withSession(session => session.withTransaction(async () => {
    const options = { ...readBson, session }
    const existing = await records.findOne(idFilter(document._id), options)
    if (!existing) {
      const buildingLinks = links.filter(link => link.type === 'property_building')
      for (const link of links) {
        const target = otherEndpoint(link, source)
        const record = await db.collection(target.collection).findOne(idFilter(target.id), options)
        if (!record) throw new EntryError('A linked record changed or was removed. Prepare the entry again.', 409)
        if (link.type === 'property_unit') {
          const buildings = await unitBuildings(db, target.id, session)
          if (buildings.length !== 1 || !buildingLinks.some(building =>
            canonical(otherEndpoint(building, source).id) === canonical(buildings[0]._id))) {
            throw new EntryError('The linked unit’s building changed. Prepare the entry again.', 409)
          }
        }
      }

      const duplicateFilter = Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, { $eq: value }]))
      const candidates = records.find(duplicateFilter, options)
      for await (const candidate of candidates) {
        const endpoint = { collection, id: candidate._id }
        let allLinked = true
        for (const link of links) {
          if (!await relationshipsCollection.findOne(matchingLink(link, endpoint, otherEndpoint(link, source)), options)) {
            allLinked = false
            break
          }
        }
        if (allLinked) throw new EntryError('A matching entry already exists. Review the existing record before adding another.', 409)
      }
      await records.insertOne(document, { session })
    }
    const saved = await records.findOne(idFilter(document._id), options)
    if (!saved || saved.description !== document.description) throw new EntryError('The saved description could not be verified.', 409)
    for (const link of links) {
      const filter = idFilter(link._id)
      if (!existing) await relationshipsCollection.insertOne(link, { session })
      const stored = await relationshipsCollection.findOne(filter, options)
      if (!stored || stored.type !== link.type || stored.description !== link.description ||
          endpointKey(stored.endpointA) !== endpointKey(link.endpointA) || endpointKey(stored.endpointB) !== endpointKey(link.endpointB)) {
        throw new EntryError('A saved relationship could not be verified.', 409)
      }
    }
    return publicRecord(collection, saved)
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }))
}
