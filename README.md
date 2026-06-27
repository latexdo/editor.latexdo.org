# LatexDo Cloud

Cloudflare-hosted backend and deployment for the real LatexDo web editor.

This repo does **not** replace [`latexdo`](https://github.com/latexdo/latexdo). The split is:

- `latexdo`: desktop app and shared React/Monaco editor UI.
- `latexdo-cloud`: Cloudflare Worker, Cloudflare Container backend, TeX runtime, deployment, and hosted editor API.

## Architecture

```text
editor.latexdo.org
  -> Cloudflare Worker
      -> static LatexDo frontend from ./dist
      -> /api/* proxied to Cloudflare Container
          -> Fastify API
          -> project files under LATEXDO_DATA_ROOT
          -> latexmk + TeX Live compilation
```

The frontend is built from the sibling `latexdo` repo with `VITE_LATEXDO_RUNTIME=cloud`, so it uses HTTP APIs instead of browser `localStorage`.

## What works in this scaffold

- Web editor static hosting through Cloudflare Workers assets.
- Per-browser-session cloud projects.
- File tree, file read/write, file/folder creation, and move operations.
- Real LaTeX compilation with `latexmk` inside the backend container.
- PDF retrieval from the compiled project.

## Deliberately not enabled yet

- Public auth.
- Durable multi-user account storage.
- Git operations.
- DOCX/Markdown import.
- Real terminal access.
- SyncTeX source/PDF jumps.

Those should be added after auth and compile sandboxing are hardened.

## Local setup

From this repo:

```sh
npm install
LATEXDO_FRONTEND_REPO=/Users/omar/Desktop/Github/latexdo npm run build:frontend
npm run dev
```

For backend-only local development:

```sh
npm install
LATEXDO_DATA_ROOT=./storage/dev npm run server:dev
```

The backend listens on `PORT` or `8787`.

## Cloudflare deploy

Required GitHub repository secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The token needs permission to deploy Workers, assets, durable objects, and Containers for the account/zone.

Deploy manually:

```sh
npm install
LATEXDO_FRONTEND_REPO=/Users/omar/Desktop/Github/latexdo npm run build:frontend
npx wrangler deploy
```

The GitHub Actions workflow does the same on `main`.

## Domain

Attach `editor.latexdo.org` to this Worker in Cloudflare. This replaces the static GitHub Pages editor target for the real hosted editor.

## Security notes

LaTeX compilation is not a harmless operation. This scaffold already runs without shell escape and inside a non-root container user, but production still needs:

- authentication before public launch
- per-user/project quotas
- compile timeout, memory, and disk limits reviewed against your Cloudflare plan
- persistent storage design, such as R2 or external storage, if projects must survive container replacement
- abuse monitoring and request rate limits
