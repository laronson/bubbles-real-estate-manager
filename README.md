# Property Inventory

A React website with an Express backend for the `real_estate_management` database on MongoDB Atlas.

## Run locally

1. Install Node.js 22 or newer and run `npm ci`.
2. Copy `.env.example` to `.env`. Set `MONGODB_URI` to the Cluster0 connection string using an Atlas database user with read access to `real_estate_management` and update access for the collections you want to edit. Your machine must be permitted by the cluster's network access settings.
3. Run `npm run build`, then `npm start`.
4. Open <http://127.0.0.1:3000>. For frontend development, keep the backend running and run `npm run dev` in a second terminal.

The server listens on loopback. A record link such as `/record?collection=inspections&id=inspection-123` works directly on the same app instance. Sharing links across machines requires a shared host with authenticated access to the inventory.

## Run the site and API together on Render

Create one Node Web Service on the Free plan. Express serves the React app and `/api` under the same domain. Use the existing `bubbles-real-estate-manager` Firebase project for Google sign-in.

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build:render` |
| Start command | `node server/render.js` |
| Health check path | `/healthz` |

Add these environment variables in Render:

- `MONGODB_URI` holds the Atlas connection string.
- `INVENTORY_ALLOWED_EMAILS` holds a comma-separated list of approved Google account email addresses.
- `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_API_KEY` come from the Firebase web app configuration in Project settings. These two values are public web configuration.

In Firebase Authentication, add the Render hostname and any custom frontend hostname under **Settings → Authorized domains**. In Atlas Network Access, add the outbound IP ranges shown under **Connect → Outbound** for the Render service. Verify that a signed-out `/api/access` request returns HTTP 401, then sign in as an approved user and run a search.

## Search behavior

- Buildings and standalone units load as dropdown options. A `building_unit` relationship determines which building a unit belongs to. The inventory query runs on form submission.
- A blank unit shows records with a `property_building` link to the selected building, excluding records with a `property_unit` link to one of its units. A unit search shows records with a `property_unit` link to that unit.
- Collections with matches appear automatically. Record lists and detail headings use the stored `description` or fall back to the record ID. The details page displays the full document, including nested fields. MongoDB dates display in U.S. Eastern time with EST or EDT shown as appropriate. Existing date strings keep their stored format. Other BSON-specific values use MongoDB Extended JSON.
- Each record detail page looks up its `{ collection, id }` on either endpoint of the `relationships` collection and loads the records on the opposite endpoints. Both endpoint pairs have compound lookup indexes. Existing `references` arrays and reinspections with `initialInspectionId` still work during the transition.
