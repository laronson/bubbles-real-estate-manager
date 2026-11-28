import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { MongoClient } from 'mongodb'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { requireInventoryAccess } from './auth.js'

const requiredSettings = ['MONGODB_URI', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_API_KEY']
const missingSettings = requiredSettings.filter(key => !process.env[key]?.trim())
if (missingSettings.length) {
  console.error(`Missing Render environment variables: ${missingSettings.join(', ')}`)
  process.exit(1)
}

const auth = getAuth(initializeApp({ projectId: process.env.VITE_FIREBASE_PROJECT_ID }))
const authorize = requireInventoryAccess(token => auth.verifyIdToken(token))
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
const staticDirectory = fileURLToPath(new URL('../dist-render/', import.meta.url))
const app = createApp(client.db('real_estate_management'), { authorize, staticDirectory })
app.get('/healthz', (_req, res) => res.status(204).end())

const port = Number(process.env.PORT ?? 10000)
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Property Inventory is listening on port ${port}.`)
})
process.once('SIGTERM', () => {
  server.close(async () => {
    await client.close()
  })
})
