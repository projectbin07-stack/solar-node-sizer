# Contributing

Bug reports, corrections to the models or presets, measured data from real
nodes, and pull requests are welcome.

## Setup

```bash
git clone https://github.com/projectbin07-stack/solar-node-sizer.git
cd solar-node-sizer
npm ci            # dev tools only: TypeScript (type checking), Prettier, Node types
npm run serve     # http://127.0.0.1:8000/
```

The site has no runtime dependencies and no build step: `index.html` loads
the ES modules in `src/` directly. Any static file server works.

## Checks

All of these must pass; CI runs them on Ubuntu and Windows with Node 22 and 24,
plus a CLI smoke test and a headless Chrome smoke test of the page.

```bash
npm run format:check
npm run typecheck
npm run coverage      # node:test with line, branch and function thresholds
```

`npm run check` runs all three.

## Guidelines

- Keep the shipped page free of runtime dependencies and network calls. Dev
  tools go in `devDependencies` and must not be imported from `src/`.
- Keep computation out of `src/ui/app.js` and `src/ui/draw.js`. Everything
  that computes a number lives in `src/core/` (or `src/ui/state.js`) and has
  tests.
- Test against values you can derive independently: a published reference
  value, a hand calculation, a datasheet figure. A test that only checks
  that code runs is not enough.
- Implement documented equations yourself and cite them in
  `docs/models.md`; do not copy code from other libraries.
- If you change a model, a preset or a default, update `docs/models.md` and
  the README numbers that depend on it, and put before/after CLI output in
  the pull request.
- Presets are illustrative. Do not describe one as matching a specific
  product or site unless you include the data behind it. Do not commit
  downloaded PVGIS files; `scripts/fit-climate.js` works on files you keep
  locally.
- Measured data from a real node (battery voltage and current over weeks,
  with the panel, location and firmware duty cycle) would be the most useful
  contribution: nothing here has been validated against hardware yet.
- Types are JSDoc comments checked by `tsc --checkJs` in strict mode.
- Small, focused commits with imperative messages.
