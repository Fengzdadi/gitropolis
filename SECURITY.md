# Security

## Reporting a problem

Please **don't** open a public issue for a security problem. Report it privately through [GitHub's private vulnerability reporting](https://github.com/Fengzdadi/gitropolis/security/advisories/new) instead.

Include what you found, how to reproduce it, and what someone could do with it. You'll get a reply within a week, and a note on what will be fixed and when.

## What's in scope

- **The command line** (`npx gitropolis`): its local server, scanning a repo, and filming in headless Chrome. A repo's file names, paths and commit messages are untrusted input.
- **gitropolis.dev**: the Worker, the scanning containers, and anything they store or serve.

## What isn't

- Problems in the vendored libraries under `web/vendor/` (three.js, d3-hierarchy, gifenc, mp4-muxer): please report those to their projects.
- Rate limits, or a repo that's too big to scan: those are known limits, not vulnerabilities.
