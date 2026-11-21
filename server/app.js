import express from 'express'
import { BSON, Double, Int32, ObjectId } from 'mongodb'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const { EJSON } = BSON
const buildingCollection = 'buildings'
const unitCollection = 'units'
const relationshipCollection = 'relationships'
const propertyRelationships = {
  buildingUnit: 'building_unit',
  buildingRecord: 'property_building',
  unitRecord: 'property_unit',
}
const inventoryTimeZone = 'America/New_York'
const easternDate = new Intl.DateTimeFormat('en-US', {
  timeZone: inventoryTimeZone,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
})
const easternOffset = new Intl.DateTimeFormat('en-US', {
  timeZone: inventoryTimeZone,
  timeZoneName: 'longOffset',
})
const dayInMilliseconds = 86_400_000
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/

function offsetAt(timestamp) {
  const offset = easternOffset.formatToParts(timestamp).find(part => part.type === 'timeZoneName').value
  const [, sign, hours, minutes, seconds = '0'] = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset)
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000
}

function datePickerValue(value) {
  if (!(value instanceof Date)) return null
  const wallTime = new Date(value.getTime() + offsetAt(value.getTime()))
  if (!Number.isFinite(wallTime.getTime())) return null
  const calendarDate = wallTime.toISOString().split('T')[0]
  return calendarDatePattern.test(calendarDate) && !calendarDate.startsWith('0000-') ? calendarDate : null
}

function replaceCalendarDate(previous, text) {
  if (!(previous instanceof Date) || !calendarDatePattern.test(text)) throw new Error('Invalid date')
  const day = Date.parse(text + 'T00:00:00.000Z')
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== text || text.startsWith('0000-')) {
    throw new Error('Invalid date')
  }
  if (text === datePickerValue(previous)) return previous

  const original = previous.getTime()
  const originalWallTime = original + offsetAt(original)
  const timeOfDay = originalWallTime - Math.floor(originalWallTime / dayInMilliseconds) * dayInMilliseconds
  const wallTime = day + timeOfDay
  const before = offsetAt(wallTime - dayInMilliseconds)
  const after = offsetAt(wallTime + dayInMilliseconds)
  const earlier = wallTime - before
  // Use the earlier occurrence of a repeated time and move forward through a skipped time.
  return new Date(offsetAt(earlier) === before || before < after ? earlier : wallTime - after)
}

function formatDates(value) {
  if (value instanceof Date) return easternDate.format(value)
  if (Array.isArray(value)) return value.map(formatDates)
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, formatDates(field)]))
  }
  return value
}

const identifierNames = [
  /(?:^|[_-])(?:ids?|uuids?|guids?)(?:$|[_-])/i,
  /(?:Id|Uuid|Guid|ID|UUID|GUID)[sS]?(?:$|[A-Z])/,
  /^(?:building|unit|tenancy|tenant|occupant|vendor|property|record|appliance|inspection|repair|user|account|customer|employee|owner|external)ids?$/i,
]

function isIdentifier(name) {
  return identifierNames.some(pattern => pattern.test(name))
}

function isIdentifierValue(value) {
  return value instanceof ObjectId || (value instanceof BSON.Binary && value.sub_type === BSON.Binary.SUBTYPE_UUID)
}

function canEditField(name, value) {
  return name !== '' && name !== 'references' && !/^\$|[.\0]/.test(name) && !isIdentifier(name) && !isIdentifierValue(value)
}

function serialize(value) {
  return EJSON.serialize(formatDates(value), { relaxed: false })
}

function editText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Int32 || value instanceof Double) return String(value.valueOf())
  return EJSON.stringify(value, null, 2, { relaxed: false })
}

function parseEdit(text, previous) {
  if (typeof previous === 'string') return text
  if (previous instanceof Date) {
    const date = new Date(text)
    if (Number.isNaN(date.getTime())) throw new Error('Invalid date')
    return date
  }
  if (previous instanceof Int32 || previous instanceof Double) {
    const number = Number(text)
    if (!text.trim() || !Number.isFinite(number)) throw new Error('Invalid number')
    if (previous instanceof Double) return new Double(number)
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
      throw new Error('Invalid integer')
    }
    return new Int32(number)
  }
  return EJSON.parse(text, { relaxed: false })
}

function containsChangedIdentifier(previous, next) {
  if (previous === next) return false
  const before = new Map(previous && typeof previous === 'object' ? Object.entries(previous) : [])
  const after = new Map(next && typeof next === 'object' ? Object.entries(next) : [])
  return [...new Set([...before.keys(), ...after.keys()])].some(name => {
    const uuid = name === '$binary' && [before.get(name), after.get(name)].some(value => value?.subType === '04')
    if (isIdentifier(name) || name === '$oid' || name === '$id' || uuid) {
      return before.has(name) !== after.has(name)
        || JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))
    }
    return containsChangedIdentifier(before.get(name), after.get(name))
  })
}

function endpointKey({ collection, id }) {
  return EJSON.stringify([collection, id], { relaxed: false })
}

function idsByCollection(endpoints) {
  const groups = new Map()
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.collection !== 'string' || !Object.hasOwn(endpoint, 'id')) continue
    const ids = groups.get(endpoint.collection) ?? new Map()
    ids.set(endpointKey(endpoint), endpoint.id)
    groups.set(endpoint.collection, ids)
  }
  return groups
}

function oppositeEndpoints(links, endpoints) {
  const keys = new Set(endpoints.map(endpointKey))
  return links.flatMap(({ endpointA, endpointB }) => {
    if (!endpointA || !endpointB) return []
    return [
      ...(keys.has(endpointKey(endpointA)) ? [endpointB] : []),
      ...(keys.has(endpointKey(endpointB)) ? [endpointA] : []),
    ]
  }).filter(endpoint => !keys.has(endpointKey(endpoint)))
}

export function createApp(db, { authorize, staticDirectory = dist } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    next()
  })
  if (authorize) {
    app.use('/api', authorize)
    app.get('/api/access', (_req, res) => res.status(204).end())
  }

  async function inventoryCollections() {
    const collections = await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()
    return collections.map(({ name }) => name)
      .filter(name => name !== relationshipCollection && !name.startsWith('system.'))
      .sort()
  }

  async function findRelationships(endpoints, type) {
    const groups = idsByCollection(endpoints)
    if (!groups.size) return []
    const filters = [...groups].flatMap(([collection, ids]) => ['endpointA', 'endpointB'].map(field => ({
      [`${field}.collection`]: collection,
      [`${field}.id`]: { $in: [...ids.values()] },
    })))
    return db.collection(relationshipCollection)
      .find({ ...(type && { type }), $or: filters }, { projection: { endpointA: 1, endpointB: 1 }, promoteValues: false })
      .toArray()
  }

  async function linkedTo(endpoints, type) {
    return oppositeEndpoints(await findRelationships(endpoints, type), endpoints)
  }

  async function groupRecords(collections, filterFor) {
    const groups = await Promise.all(collections.map(async collection => {
      const records = await db.collection(collection)
        .find(filterFor(collection), { projection: { description: 1 }, promoteValues: false })
        .sort({ description: 1, _id: 1 })
        .toArray()
      const items = records.map(({ _id, description }) => ({
        id: String(_id),
        ...(typeof _id === 'string' ? {} : { bsonId: EJSON.stringify(_id, { relaxed: false }) }),
        description,
      }))
      return { collection, items }
    }))
    return groups.filter(({ items }) => items.length)
  }

  app.get('/api/buildings', async (_req, res) => {
    const buildings = await db.collection(buildingCollection)
      .find({}, { projection: { name: 1, address: 1 } })
      .sort({ name: 1, address: 1, _id: 1 })
      .toArray()
    const endpoints = buildings.map(({ _id }) => ({ collection: buildingCollection, id: _id }))
    const links = await findRelationships(endpoints, propertyRelationships.buildingUnit)
    const unitIds = idsByCollection(oppositeEndpoints(links, endpoints)).get(unitCollection)
    const units = unitIds?.size ? await db.collection(unitCollection)
      .find({ _id: { $in: [...unitIds.values()] } }, { projection: { label: 1 } })
      .sort({ label: 1, _id: 1 })
      .toArray() : []
    res.json(buildings.map((building, index) => {
      const linked = idsByCollection(oppositeEndpoints(links, [endpoints[index]])).get(unitCollection)
      return { ...building, units: units.filter(({ _id }) => linked?.has(endpointKey({ collection: unitCollection, id: _id })))
        .map(({ _id, label }) => ({ id: _id, label })) }
    }))
  })

  app.get('/api/search', async (req, res) => {
    const { buildingId, unitId = '' } = req.query
    if (typeof buildingId !== 'string' || !buildingId || typeof unitId !== 'string') {
      return res.status(400).json({ error: 'Select a valid building and unit.' })
    }

    const building = { collection: buildingCollection, id: buildingId }
    const [buildingRecord, linkedUnits, collections] = await Promise.all([
      db.collection(buildingCollection).findOne({ _id: buildingId }, { projection: { _id: 1 } }),
      linkedTo([building], propertyRelationships.buildingUnit),
      inventoryCollections(),
    ])
    const units = linkedUnits.filter(endpoint => endpoint.collection === unitCollection)
    const selectedUnit = unitId ? units.find(endpoint => endpoint.id === unitId) : undefined
    const unitRecord = selectedUnit && await db.collection(unitCollection)
      .findOne({ _id: unitId }, { projection: { _id: 1 } })
    if (!buildingRecord || (unitId && !unitRecord)) {
      return res.status(404).json({ error: 'The selected building or unit was not found.' })
    }

    let endpoints
    if (selectedUnit) {
      endpoints = await linkedTo([selectedUnit], propertyRelationships.unitRecord)
    } else {
      const [buildingRecords, unitRecords] = await Promise.all([
        linkedTo([building], propertyRelationships.buildingRecord),
        linkedTo(units, propertyRelationships.unitRecord),
      ])
      const unitRecordKeys = new Set(unitRecords.map(endpointKey))
      endpoints = buildingRecords.filter(endpoint => !unitRecordKeys.has(endpointKey(endpoint)))
    }
    const groups = idsByCollection(endpoints)
    res.json(await groupRecords(collections.filter(collection => groups.has(collection)), collection => ({
      _id: { $in: [...groups.get(collection).values()] },
    })))
  })

  async function loadRecord(req, res, next) {
    const { collection, id, bsonId } = req.query
    if (typeof collection !== 'string' || typeof id !== 'string' || !id ||
        (bsonId !== undefined && typeof bsonId !== 'string')) {
      return res.status(400).json({ error: 'The record link is incomplete.' })
    }
    const collections = await inventoryCollections()
    if (!collections.includes(collection)) {
      return res.status(404).json({ error: 'Collection not found.' })
    }

    let recordId = id
    if (bsonId !== undefined) {
      try {
        recordId = EJSON.parse(bsonId, { relaxed: false })
      } catch {
        return res.status(400).json({ error: 'The record ID is invalid.' })
      }
    }
    const records = db.collection(collection)
    const readRecord = _id => records.findOne({ _id: { $eq: _id } }, { promoteValues: false })
    const record = await readRecord(recordId)
      ?? (bsonId === undefined && /^[a-f\d]{24}$/i.test(id) ? await readRecord(new ObjectId(id)) : null)
    if (!record) return res.status(404).json({ error: 'Record not found.' })
    res.locals.collections = collections
    res.locals.records = records
    res.locals.record = record
    next()
  }

  app.get('/api/record', loadRecord, (req, res) => {
    const { record } = res.locals
    const data = serialize(record)
    if (req.query.edit !== '1') return res.json(data)
    const editableEntries = Object.entries(record).filter(([name, value]) => canEditField(name, value))
    const editableFields = Object.fromEntries(editableEntries
      .map(([name, value]) => [name, editText(value)]))
    const dateFields = Object.fromEntries(editableEntries
      .filter(([, value]) => value instanceof Date)
      .map(([name, value]) => [name, datePickerValue(value)]))
    res.json({ data, editableFields, dateFields })
  })

  app.get('/api/record/related', loadRecord, async (req, res) => {
    const { collections, record } = res.locals
    const targetCollection = req.query.collection
    const targetId = { $eq: record._id }
    const current = { collection: targetCollection, id: record._id }
    const endpoints = await linkedTo([current])
    // Keep navigating legacy links while their collections migrate to relationships.
    if (Array.isArray(record.references)) endpoints.push(...record.references)
    if (targetCollection === 'inspections' && record.initialInspectionId != null) {
      endpoints.push({ collection: targetCollection, id: record.initialInspectionId })
    }
    const groups = idsByCollection(endpoints)
    const reference = { references: { $elemMatch: { collection: targetCollection, id: targetId } } }

    res.json(await groupRecords(collections, collection => {
      const filters = [reference]
      if (groups.has(collection)) filters.push({ _id: { $in: [...groups.get(collection).values()] } })
      // Existing reinspections predate the references field.
      if (collection === targetCollection && collection === 'inspections') {
        filters.push({ initialInspectionId: targetId })
      }
      return {
        ...(collection === targetCollection && { _id: { $ne: record._id } }),
        $or: filters,
      }
    }))
  })

  app.patch('/api/record', express.json(), loadRecord, async (req, res) => {
    const { record, records } = res.locals
    const { name: requestedName, original, text, calendarDate } = req.body ?? {}
    const adding = original === null
    if (typeof requestedName !== 'string' || typeof text !== 'string' || (!adding && typeof original !== 'string')) {
      return res.status(400).json({ error: 'Enter an attribute name and value.' })
    }
    const name = adding ? requestedName.trim() : requestedName
    const exists = Object.hasOwn(record, name)
    if (!canEditField(name, record[name]) || (!adding && !exists)) {
      const error = adding
        ? 'Enter a name without periods, a leading dollar sign, or a reserved identifier name.'
        : 'This attribute cannot be edited.'
      return res.status(400).json({ error })
    }
    const duplicate = 'An attribute with this name already exists.'
    if (adding && exists) return res.status(409).json({ error: duplicate })

    const previous = record[name]
    if (!adding && editText(previous) !== original) {
      return res.status(409).json({ error: 'This value changed since you opened it. Reload the record before editing it again.' })
    }
    let value
    try {
      if (calendarDate === true) value = replaceCalendarDate(previous, text)
      else value = adding ? text : text === original ? previous : parseEdit(text, previous)
    } catch {
      return res.status(400).json({ error: 'Enter a valid value using the format shown in the editor.' })
    }
    if (!adding && containsChangedIdentifier(EJSON.serialize(previous, { relaxed: false }), EJSON.serialize(value, { relaxed: false }))) {
      return res.status(400).json({ error: 'Identifiers inside this attribute cannot be changed.' })
    }
    if (name === 'description' && (typeof value !== 'string' || !value.trim())) {
      return res.status(400).json({ error: 'Enter a description before saving.' })
    }

    const filter = { _id: { $eq: record._id }, [name]: { $exists: !adding } }
    if (!adding) filter.$expr = { $eq: ['$' + name, { $literal: previous }] }
    const updated = await records.findOneAndUpdate(
      filter,
      { $set: { [name]: value } },
      { returnDocument: 'after', promoteValues: false },
    )
    if (!updated) {
      const error = adding ? duplicate : 'This value changed while you were editing it. Reload the record and try again.'
      return res.status(409).json({ error })
    }
    const updatedValue = updated[name]
    res.json({ value: serialize(updatedValue), editText: editText(updatedValue), date: datePickerValue(updatedValue) })
  })

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }))
  app.use(express.static(staticDirectory))
  app.get('/record', (_req, res) => res.sendFile('index.html', { root: staticDirectory }))

  app.use((error, req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The edit request is invalid.' })
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The edited value is too large.' })
    if (req.method === 'PATCH' && error.code === 13) {
      return res.status(403).json({ error: 'The Atlas connection does not have permission to update this collection.' })
    }
    if (req.method === 'PATCH' && error.code === 121) {
      return res.status(400).json({ error: 'This value does not meet the collection’s validation rules.' })
    }
    console.error(error.name)
    res.status(500).json({ error: req.method === 'PATCH' ? 'Could not save the edited value.' : 'Could not load inventory data.' })
  })

  return app
}
