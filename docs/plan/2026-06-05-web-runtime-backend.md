# Web runtime backend plan

## Scope

- Add a browser Web runtime that can start with an independent Node backend.
- Reuse the existing Electron runtime domain functions for projects, model catalog, tasks, assets, exports, agents, and onboarding.
- Add a Web transport adapter instead of duplicating business logic.
- Add development and production scripts for:
  - backend only
  - Web renderer only
  - combined Web development
  - Web production build/start

## Out Of Scope

- No visual redesign of the workbench or project library.
- No paid model generation or export smoke that calls real providers.
- No OS-native folder picker in Web. Browser mode will expose a limited workspace bridge and keep local folder selection desktop-only.
- No new backend framework dependency unless the native Node HTTP server proves insufficient.

## Architecture

- Keep Electron IPC as the desktop transport.
- Add `electron/web/*` as the HTTP/SSE transport layer.
- Make runtime infrastructure work outside Electron by resolving paths and secret storage through lazy environment adapters.
- Install a browser-side `nomiDesktop` compatibility bridge only when `VITE_NOMI_RUNTIME=web`.
- Convert `nomi-local://asset/...` to `/api/assets/file/...` at the Web bridge boundary, and convert it back before saving or exporting.

## Rollback

- Remove the new `electron/web/*`, `src/web/*`, and `scripts/*web*` files.
- Revert the small environment-adapter changes in `electron/runtimePaths.ts` and `electron/catalog/secrets.ts`.
- Revert package scripts and Vite proxy additions.
- Existing Electron scripts should continue to work because the default renderer build does not enable the Web bridge.

## Acceptance Gates

- `pnpm run check:filesize`
- `pnpm run lint:ci`
- `pnpm run typecheck`
- focused Vitest coverage for Web transport helpers
- `pnpm run build`
- `pnpm run build:web`
- local Web smoke: backend + renderer start, project library renders in a browser page

## Result

- Added a Node HTTP backend under `electron/web/*` with JSON RPC, SSE streams, static `dist/` serving, and `nomi-local://asset/...` file serving.
- Added a browser-side Web bridge under `src/web/*` that preserves the existing `window.nomiDesktop` renderer contract while calling the HTTP backend.
- Split onboarding connection/list-models probing into a shared domain helper so Electron IPC and Web RPC do not duplicate the provider logic.
- Made runtime paths and catalog secret storage work with and without Electron through a lazy runtime adapter.
- Added Web scripts:
  - `pnpm run dev:web`
  - `pnpm run dev:web:backend`
  - `pnpm run dev:web:renderer`
  - `pnpm run build:web`
  - `pnpm run start:web`

## Verification

- `pnpm run check:filesize` passed.
- `pnpm run lint:ci` passed with the existing warning baseline (`97/98`).
- `pnpm run typecheck` passed.
- `pnpm exec vitest run` passed (`68` files, `539` tests).
- `pnpm run build` passed.
- `pnpm run build:web` passed.
- Web smoke passed against `http://127.0.0.1:8787` using isolated temp roots:
  - `document.title === "Nomi"`
  - `window.nomiDesktop.platform === "web"`
  - `/api/health` returned `{ ok: true, runtime: "web" }`
  - project list RPC returned successfully
  - no browser console errors
