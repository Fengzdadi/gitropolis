Vendored, unmodified, so `npx gitropolis` works offline:

- `three/` — three.js 0.169.0 (`build/three.module.min.js`, and the addons the viewer imports from `examples/jsm/` with their dependencies), MIT, see `three/LICENSE`
- `d3-hierarchy/` — d3-hierarchy 3.1.2 (its `src/` ES modules), ISC, see `d3-hierarchy/LICENSE`
- `gifenc/` — gifenc 1.0.3 (`dist/gifenc.esm.js`), MIT, see `gifenc/LICENSE.md`: GIF encoding for share films
- `mp4-muxer/` — mp4-muxer 5.2.1 (`build/mp4-muxer.mjs`, saved as `.js`), MIT, see `mp4-muxer/LICENSE`: MP4 files from WebCodecs for share films

The import maps in `../index.html` and `../gallery.html` point here.
