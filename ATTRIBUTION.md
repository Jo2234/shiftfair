# Attribution

## Authorship and AI assistance

ShiftFair was created by Johan Vaz. The design, contracts, implementation and
tests were produced with substantial AI assistance:

- **OpenAI GPT-6.1 Sol** (via Codex) — project coordination and the
  implementation of application code and tests.
- **Anthropic Claude Opus 5.5** (via Claude Code) — planning, interface
  contracts, code review, integration fixes (including parts of the solver,
  gap explanations and import limits) and documentation.

All AI output was reviewed against written contracts and automated tests.
The app itself uses no AI, model, API or provider at runtime.

## Libraries and tools

The app requires **no runtime package installation or external service**.
Vite bundles the application into static files; build tools transform the code.
The unnecessary module-preload polyfill is disabled. Development tools:

| Package | Version (lockfile) | License | Use |
|---|---|---|---|
| [Vite](https://vite.dev/) | 7.3.7 | MIT | dev server and production bundling |
| [TypeScript](https://www.typescriptlang.org/) | 5.9.3 | Apache-2.0 | type checking |
| [jsdom](https://github.com/jsdom/jsdom) | 26.1.0 | MIT | DOM for UI tests |
| @types/node, @types/jsdom | 24.19.2, 21.1.7 | MIT | type definitions |

These pull in further development-only transitive packages (esbuild, Rollup,
PostCSS and others) under MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and
MIT-0 licenses; see `package-lock.json`. Tests use Node.js's built-in
`node:test` runner.

No third-party images, fonts, icons or datasets are included.
