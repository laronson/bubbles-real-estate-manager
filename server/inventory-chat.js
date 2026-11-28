import express from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { BSON } from 'mongodb'
import { entryTools, EntryError, previewEntry, saveEntry } from './inventory-entry.js'
import { openAIInventory } from './openai-inventory.js'

const { EJSON } = BSON
const maxMessageLength = 3000
const maxMessages = 12

export function inventoryChatFromEnv(env = process.env) {
  const key = env.OPENAI_API_KEY?.trim()
  if (!key) return null
  return {
    key,
    respond: openAIInventory({ apiKey: key, model: env.OPENAI_INVENTORY_MODEL?.trim() || 'gpt-6.1-terra' }),
  }
}

export function inventoryChatRoutes(db, config) {
  const router = express.Router()
  router.get('/', (_req, res) => res.json({ enabled: Boolean(config) }))
  router.use((_req, res, next) => {
    if (!config) return res.status(503).json({ error: 'Inventory chat is disabled. Set OPENAI_API_KEY on the server to enable it.' })
    next()
  })
  router.use(express.json({ limit: '128kb' }))

  const signature = payload => createHmac('sha256', config.key).update('inventory-draft:' + payload).digest()

  router.post('/', async (req, res) => {
    const { messages } = req.body ?? {}
    if (!Array.isArray(messages) || !messages.length || messages.length > maxMessages ||
        messages.at(-1)?.role !== 'user' || messages.some(message =>
          !['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' ||
          !message.content.trim() || message.content.length > maxMessageLength)) {
      throw new EntryError('Enter a message of up to 3,000 characters.')
    }

    const tools = entryTools(db)
    let reply
    try {
      reply = await config.respond(messages.map(({ role, content }) => ({ role, content: content.trim() })), tools.invoke)
    } catch (error) {
      console.error('Inventory chat request failed:', error.code ?? error.name)
      return res.status(502).json({ error: 'Could not prepare an inventory entry. Try sending your message again.' })
    }
    const draft = tools.draft
    if (!draft) return res.json({ message: reply.slice(0, maxMessageLength) })

    const payload = Buffer.from(EJSON.stringify({
      owner: res.locals.inventoryUser ?? 'local',
      expires: Date.now() + 30 * 60 * 1000,
      draft,
    }, { relaxed: false })).toString('base64url')
    res.json({
      message: 'Review the proposed entry and its links.',
      draft: { ...previewEntry(draft), token: payload + '.' + signature(payload).toString('base64url') },
    })
  })

  router.post('/save', async (req, res) => {
    const token = req.body?.token
    const match = typeof token === 'string' && /^([\w-]+)\.([\w-]{43})$/.exec(token)
    const invalid = () => new EntryError('This draft is invalid or expired. Prepare the entry again.', 409)
    if (!match || !timingSafeEqual(signature(match[1]), Buffer.from(match[2], 'base64url'))) throw invalid()
    const { owner, expires, draft } = EJSON.parse(Buffer.from(match[1], 'base64url').toString(), { relaxed: false })
    if (String(expires) <= Date.now() || owner !== (res.locals.inventoryUser ?? 'local')) throw invalid()
    res.json({ record: await saveEntry(db, draft) })
  })

  router.use((error, _req, res, _next) => {
    if (error instanceof EntryError) return res.status(error.status).json({ error: error.message })
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The inventory chat request is invalid.' })
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The inventory chat request is too large.' })
    if (error.code === 13) return res.status(403).json({ error: 'The Atlas connection lacks permission to add this entry or its links.' })
    if (error.code === 121) return res.status(400).json({ error: 'The entry does not meet the collection’s validation rules. Update the details and try again.' })
    if (error.code === 11000) return res.status(409).json({ error: 'This entry or one of its links conflicts with an existing record.' })
    console.error('Inventory entry save failed:', error.code ?? error.name)
    return res.status(500).json({ error: 'Could not verify the save. Retry this draft to check the result.' })
  })
  return router
}
