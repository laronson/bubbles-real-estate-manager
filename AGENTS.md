# Property Inventory codebase

## Where to start

- Read [README.md](README.md) for local setup and the app’s search behavior.
- [src/main.jsx](src/main.jsx) renders the React search and record pages. [src/styles.css](src/styles.css) contains their styles.
- [server/app.js](server/app.js) exports `createApp(db)` and defines the Express API, including property search, related records, and record editing.
- [server/index.js](server/index.js) connects to MongoDB and starts the HTTP server. [vite.config.js](vite.config.js) configures the development proxy for `/api`.

## Working on the app

- Trace search and record changes from the UI through the Express route. Keep related-record lookups driven by the stored endpoints so new inventory collections can appear without route changes. Preserve BSON ID types when resolving and linking to records.
- Use Node.js 22 or newer and install dependencies with `npm ci`. Run `npm run build` to check the frontend. For API changes, exercise the affected routes through `createApp(db)` with a fixture or a configured database.
- Use the **Real Estate Inventory → Add Entry** skill for live inventory work.
- Before using ui-sdk, follow the ui-sdk skill if it is installed and read `node_modules/@ui-sdk/react/docs/llms.txt`. When building a new component, also search `node_modules/@ui-sdk/react/docs/core.md` by heading and read `node_modules/@ui-sdk/react/docs/rendering.md`.
