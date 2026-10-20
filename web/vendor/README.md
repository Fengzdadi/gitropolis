Vendored, unmodified, so `npx gitropolis` works offline:

- `three/` — three.js 0.169.0 (`build/three.module.min.js`, and the addons the viewer imports from `examples/jsm/` with their dependencies), MIT, see `three/LICENSE`
- `d3-hierarchy/` — d3-hierarchy 3.1.2 (its `src/` ES modules), ISC, see `d3-hierarchy/LICENSE`

The import maps in `../index.html` and `../gallery.html` point here.
