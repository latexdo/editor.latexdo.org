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
npm run dev
```

`dist/` is committed on purpose, like the static `latexdo.github.io` site. That makes the
Cloudflare deployment self-contained: Cloudflare fetches this repository and deploys the
Worker plus the already-built frontend assets from `dist/`.

To refresh the frontend assets from the local LatexDo app repo, run this locally and commit
the changed `dist/` files:

```sh
LATEXDO_FRONTEND_REPO=/Users/omar/Desktop/Github/latexdo npm run build:frontend
```

For backend-only local development:

```sh
npm install
LATEXDO_DATA_ROOT=./storage/dev npm run server:dev
```

The backend listens on `PORT` or `8787`.

## Cloudflare deploy

This repo is set up for Cloudflare Workers Builds, not GitHub Actions deployment.
Connect `latexdo/latexdo-cloud` to the existing Worker in Cloudflare so Cloudflare fetches
the repository and runs the deploy itself on pushes to `main`.

Use these Cloudflare Worker build settings:

```text
Root directory: repository root (leave blank)
Build command: npm run build
Deploy command: npx wrangler deploy
Non-production deploy command: npx wrangler versions upload
```

The Worker name in Cloudflare must match `name` in `wrangler.jsonc`: `latexdo-cloud`.

This Worker also deploys a Cloudflare Container from `Dockerfile`. If the Cloudflare build
logs report that Docker is unavailable, push a prebuilt image to Cloudflare Registry,
Docker Hub, or ECR and change `containers[0].image` in `wrangler.jsonc` to that image
reference.

For a manual local deploy:

```sh
npm install
npm run build
npm run deploy
```

## Domain

Attach `editor.latexdo.org` to this Worker in Cloudflare. This replaces the static GitHub Pages editor target for the real hosted editor.

## Security notes

LaTeX compilation is not a harmless operation. This scaffold already runs without shell escape and inside a non-root container user, but production still needs:

- authentication before public launch
- per-user/project quotas
- compile timeout, memory, and disk limits reviewed against your Cloudflare plan
- persistent storage design, such as R2 or external storage, if projects must survive container replacement
- abuse monitoring and request rate limits
