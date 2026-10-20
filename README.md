<div align="center">

# gitropolis

**Your git repo as a living neon city.**

Every file is a building. Every import is a sky-lane. Every commit lights up the windows.<br>
Scrub through history and watch your codebase grow from an empty lot into a skyline.

<!-- TODO: hero film -->

</div>

## Quick start

```bash
git clone https://github.com/Fengzdadi/gitropolis
cd gitropolis
node bin/cli.mjs /path/to/your/repo
```

Your browser opens on the city. No install, no build step, no dependencies — just Node 18+.

> `npx gitropolis` is coming once the package is published to npm.

## Make a README video

```bash
node bin/cli.mjs /path/to/your/repo --video city.mp4 --gif city.gif
```

One command films a 20-second fly-through: the city grows along its git timeline, then the camera dives into the busiest junction in town (your most-imported file). Rendering happens in headless Chrome, frame by frame, so it looks the same on any machine.

Outputs are sized to fit GitHub's 10 MB upload limit by default, so they drop straight into a README.

| Option | Default | |
|---|---|---|
| `--video <file>` | | MP4 (H.264), two-pass encoded under the size cap |
| `--gif <file>` | | GIF, shrunk automatically until it fits |
| `--duration <s>` | `20` | length of the film |
| `--fps <n>` | `30` | |
| `--size <WxH>` | `1920x1080` | |
| `--max-mb <n>` | `9.5` | size cap for both outputs |
| `--headed` | | record in a visible browser tab instead of headless Chrome |

Needs [ffmpeg](https://ffmpeg.org) (`brew install ffmpeg`) and Chrome, Chromium, Edge or Brave.

## How to read the city

| In the city | In your code |
|---|---|
| District | directory (nested directories are raised plates) |
| Building height & footprint | lines of code |
| Lit windows | recently edited; long-untouched files go dark |
| Red rooftop beacon | hot file (high commit churn) |
| Building flash | touched by a commit during playback |
| Sky-lane arcs and flying lights | imports, cyan at the importer → pink at the imported file |
| Street traffic | ambience (for now) |

Hover a building for its stats; click it to isolate its imports and importers (<kbd>Esc</kbd> to clear). <kbd>Space</kbd> plays / pauses the timeline.

Imports are detected for JS/TS, Python, Go, Rust and C/C++. History follows renames, so a file moved into `src/` keeps its original birthday.

## Other options

| Option | |
|---|---|
| `--port <n>` | local server port (default `4173`) |
| `--no-open` | don't open the browser |
| `--out <file>` | write the scanned city as JSON and exit |

## Status

Early prototype. Known rough edges:

- Large repos (thousands of files) look flatter than small ones; skyline tuning is next.
- Imports are found with regexes, not a real parser, so some are missed.
- Three.js loads from a CDN, so the viewer needs an internet connection.
