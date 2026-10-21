<!-- Thanks for the pull request! Bigger changes (a new city type, classification, a new option) need an issue first: link it below. -->

## What this changes

<!-- One or two sentences: what is different after this pull request? -->

Closes #

## Why

<!-- The problem it solves, or what it makes possible. -->

## Type of change

- [ ] Bug fix
- [ ] Scanner (files, imports, links, history)
- [ ] Classification (which city a repo becomes)
- [ ] City plans, buildings or rendering
- [ ] Page or sharing (timeline, labels, cards, GIFs, videos)
- [ ] Command line
- [ ] Hosted site (`deploy/cloudflare`)
- [ ] Docs only

## Before and after

<!-- For anything visible: a frame before and after (`node bin/cli.mjs <repo> --still before.png`). Same repo, same view. -->

| Before | After |
|---|---|
|  |  |

## How I checked it

<!-- Which repos did you run, and what did you look at? See "Checking a change" in CONTRIBUTING.md. -->

| Repo | Files | City before → after | Notes |
|---|---|---|---|
|  |  |  |  |

- [ ] Ran at least one small repo (under 50 files) and one large one (over 1,000)
- [ ] Played the timeline from the start: land, buildings, names and traffic appear in order
- [ ] Compared `--bench` on a big repo (only if this touches rendering or the building merge)
- [ ] The other styles still load (only if this touches shared code)

## Checklist

- [ ] No new runtime dependencies (or a vendored library with its license, explained above)
- [ ] File names and paths from a repo are never inserted as HTML
- [ ] Comments explain why, and the code matches its surroundings
- [ ] README or `--help` updated, if this adds or changes an option
