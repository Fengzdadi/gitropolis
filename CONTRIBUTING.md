# Contributing to gitropolis

Thanks for wanting to help build the city. This page covers how to run gitropolis from a checkout, how the code is laid out, how to check a change, and what a good issue or pull request looks like.

## Before you start

- **Small fixes** (a typo, a crash, an import pattern that's missed, a building that renders wrong) can go straight to a pull request.
- **Bigger changes** need an issue first: a new city type, a change to how repos are classified, a new building form, a new option, or anything that changes how every city looks. gitropolis has a strong look, and it's much easier to agree on the idea before the code.
- **A repo drawn wrong** is worth reporting even if you don't plan to fix it. Use the *"My repo looks wrong"* issue form and include the repo's link.

## Running it from a checkout

You need Node 18 or newer and git. There are no dependencies to install and nothing to build.

```bash
git clone https://github.com/Fengzdadi/gitropolis.git
cd gitropolis
node bin/cli.mjs /path/to/some/repo
```

Edit a file under `web/`, then reload the browser tab. A change under `src/` (the scanner) needs a fresh run of the command.

Useful while working:

| Command | What it's for |
|---|---|
| `node bin/cli.mjs <repo> --out city.json` | See what the scanner found, and which city it chose and why (`identity`) |
| `node bin/cli.mjs <repo> --city <plan>` | Draw a repo as any of the 14 city plans |
| `node bin/cli.mjs <repo> --still before.png` | A frame to compare before and after a visual change |
| `node bin/cli.mjs <repo> --bench` | Setup and frame timings, for anything that might slow things down |
| `http://localhost:4173/gallery.html` (while the CLI runs) | Every building form side by side |
| `http://localhost:4173/?debug=1` | Exposes `window.__city` in the console for poking at the scene |

Filming (`--gif`, `--video`, `--still`, `--card`) also needs Chrome, Chromium, Edge or Brave, and ffmpeg for GIF and MP4.

## How the code is laid out

| Path | What lives there |
|---|---|
| `bin/cli.mjs` | The command line: options, the local server, headless filming |
| `src/scan.mjs` | Reads a repo: files, imports, links, and history from `git log` |
| `src/classify.mjs` | Measures the code and picks the city type, with the reasons it prints |
| `src/anatomy.mjs` | What each file is (source, test, config, docs, data...) |
| `web/layouts.js` | The 14 city planners: streets, blocks, water, landmarks |
| `web/buildings.js` · `web/architecture.js` | Building forms, and which file gets which form |
| `web/studio.js` · `web/surfaces.js` · `web/streets.js` · `web/trees.js` | Terrain, materials, roads and traffic, trees |
| `web/pixel.js` | The pixel-art pass: palette, dithering, ink outlines |
| `web/main.js` | The page: camera, timeline, labels, hover, recording |
| `web/card.js` · `web/waiting.js` | Share cards, GIFs and videos; the waiting screen |
| `web/png.js` | Palette PNGs for cards and stills (a quarter of the browser's own PNG) |
| `web/vendor/` | three.js, d3-hierarchy, gifenc and mp4-muxer, vendored unmodified |
| `deploy/cloudflare/` | The hosted site at gitropolis.dev |

## Checking a change

There's no test suite yet. Instead, gitropolis is checked against real repos. Before opening a pull request:

1. **Pick repos that exercise your change.** Run at least one small repo (under 50 files) and one large one (over 1,000), plus any repo your change is about. Good public ones to try: `pallets/flask`, `vitejs/vite`, `TanStack/query`, `tokio-rs/axum`, `sindresorhus/ky`.
2. **Compare with `main`.** For scanner or classifier changes, diff the `identity` from `--out city.json` before and after. Most repos shouldn't change city type unless that's the point of the change. For visual changes, take `--still` frames before and after.
3. **Watch the city grow.** Play the timeline once from the start, and check that land, buildings, names and traffic appear in order.
4. **Keep it fast.** For anything in the render loop or the building merge, compare `--bench` on a big repo before and after.
5. **Check the other styles still load** if you touched shared code: `--style maquette`, `--style plan`, `--style nocturne`.

## Code style

- **Match the code around you**: its naming, its density, its way of doing things.
- **Comments say why**, not what. A comment that explains a choice ("the isometric view has no near and far, so names don't fade") is worth more than one that restates the code.
- **No runtime dependencies.** `npx gitropolis` works offline with nothing to install. If you need a library, vendor it unmodified under `web/vendor/` with its license, and say why in the pull request.
- **Treat repo content as data.** File names and paths come from someone else's repo: never put them into HTML as markup.
- **Pixel art stays pixel art.** New visuals use the palette in `web/pixel.js` and whole art pixels.

## Commit messages

A short summary line in the imperative or descriptive voice ("District signs stand in the middle of their district"), a blank line, then a few lines on what changed and why. Explain the reason for a change rather than listing every edit.

## Pull requests

- One change per pull request. Two unrelated fixes are two pull requests.
- Fill in the template: what changed, why, how you checked it, and **before and after screenshots** for anything visible.
- Keep the diff focused. Renames, reformatting and drive-by refactors make a change hard to review.
- It's fine to open a draft early and ask for direction.

Pull requests are reviewed as time allows. A pull request that isn't merged isn't a judgement on you: sometimes an idea doesn't fit the look or the scope, and we'll say why.

## The hosted site

`deploy/cloudflare/` is what runs gitropolis.dev. You can run it with `npx wrangler dev` there to work on the Worker, but deploying is done by the maintainer.

## Security

Please don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
