import { MongoClient } from 'mongodb'
import { createApp } from './app.js'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('Set MONGODB_URI in .env to connect to MongoDB Atlas.')
  process.exit(1)
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
const db = client.db('real_estate_management')
createApp(db).listen(3000, '127.0.0.1', () => {
  console.log('Property Inventory is available at http://127.0.0.1:3000')
})
