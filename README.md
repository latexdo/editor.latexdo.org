# editor.latexdo.org

This repository hosts the Cloudflare version of the LatexDo editor at `https://editor.latexdo.org`. It combines a Worker, static frontend assets, a Cloudflare Container backend, and a Fastify API for project and LaTeX operations.

## Repository Role

- Serves the hosted LatexDo frontend from `dist/`.
- Proxies `/api/*` requests from the Worker to the backend container.
- Runs a Fastify API for project files, imports, compilation, PDF output, sharing, and presence.
- Builds the hosted frontend from the sibling `latexdo` repo.

## Requirements

- Node.js 20 or newer.
- npm.
- Wrangler for local Worker previews and deploys.
- Docker or Cloudflare container support for container work.
- TeX Live, `latexmk`, and Pandoc when running backend features locally.

## Run Locally

Run the Worker preview with the committed frontend assets:

```sh
npm install
npm run dev
```

Run only the backend API:

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
npm run build           # Run type checks for deploy.
npm run build:frontend  # Rebuild dist/ from the local LatexDo app.
npm run typecheck       # Check Worker and backend TypeScript.
npm run deploy          # Deploy with Wrangler.
```

## Deploy

Manual deploy:

```sh
npm install
npm run deploy
```

Cloudflare Workers Builds should use:

```text
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

Set these for non-interactive deploys:

```text
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_API_TOKEN=<deploy token>
```

Attach `editor.latexdo.org` to the Worker in Cloudflare. If Docker is unavailable in the Cloudflare build environment, push a prebuilt backend image and update `containers[0].image` in `wrangler.jsonc`.

## Security Notes

LaTeX compilation can execute expensive or unsafe workloads if it is not controlled carefully. Keep shell escape disabled, run the backend as a non-root user, and add production controls for auth, quotas, timeouts, storage limits, abuse monitoring, and rate limiting before opening the hosted editor broadly.