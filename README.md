# editor.latexdo.org

This repository hosts the Cloudflare preview version of the LatexDo editor at `https://editor.latexdo.org`. The default deployment serves the committed frontend assets and a small preview API Worker so the editor can be opened without deploying the LaTeX backend container.

## Repository Role

- Serves the hosted LatexDo frontend from `dist/`.
- Provides preview `/api/*` responses for opening a sample cloud project and editing files in a warm Worker session.
- Returns a graceful "compilation disabled" result for PDF generation.
- Builds the hosted frontend from the sibling `latexdo` repo.

## Requirements

- Node.js 20 or newer.
- npm.
- Wrangler for local Worker previews and deploys.
- Docker, TeX Live, `latexmk`, and Pandoc are only needed if you work on the old backend code locally.

## Run Locally

Run the Worker preview with the committed frontend assets:

```sh
npm install
npm run dev
```

Run only the old backend API:

```sh
npm install
LATEXDO_DATA_ROOT=./storage/dev npm run server:dev
```

The backend listens on `PORT` or `8787` by default.

Refresh the hosted frontend from the local desktop app repo:

```sh
LATEXDO_FRONTEND_REPO=/Users/omar/Desktop/Github/latexdo npm run build:frontend
```

## Common Commands

```sh
npm run dev             # Start Wrangler dev for the Worker.
npm run server:dev      # Start the Fastify backend directly.
npm run build           # Verify the committed preview assets exist.
npm run build:frontend  # Rebuild dist/ from the local LatexDo app.
npm run typecheck       # Check Worker and backend TypeScript.
npm run deploy          # Deploy the preview Worker and static assets.
```

## Deploy

Manual preview deploy:

```sh
npm install
npm run deploy
```

Cloudflare Workers Builds should use:

```text
Build command: npm run build
Deploy command: npx wrangler deploy
```

The default `wrangler.jsonc` intentionally does not declare Cloudflare Containers or Durable Objects. This prevents Workers Builds from building the old Dockerfile-backed TeX image and failing with a container registry `Unauthorized` error. Attach `editor.latexdo.org` to the Worker in Cloudflare.

## Security Notes

LaTeX compilation can execute expensive or unsafe workloads if it is not controlled carefully. Keep shell escape disabled, run the backend as a non-root user, and add production controls for auth, quotas, timeouts, storage limits, abuse monitoring, and rate limiting before opening the hosted editor broadly.
