# Contributing

## Development Setup

```bash
npm install
npm run build
npm test
```

### Available Scripts

| Script                 | Description                     |
| ---------------------- | ------------------------------- |
| `npm test`             | Run tests with vitest           |
| `npm run test:watch`   | Run tests in watch mode         |
| `npm run build`        | Build ESM + CJS to `dist/`      |
| `npm run format`       | Auto-format with prettier       |
| `npm run format:check` | Check formatting (CI)           |
| `npm run lint:deps`    | Check for unused deps with knip |

## Testing

Tests live in `test/` and are split into:

- **`test/unit/`** — Unit tests for individual modules (no external deps)
- **`test/integration/`** — Integration tests with real libraries (Express, Knex, GraphQL, etc.)

Run all tests:

```bash
npm test
```

Run a specific test file:

```bash
npx vitest run test/unit/filtering-span-processor.test.ts
```

Watch mode for development:

```bash
npm run test:watch
```

### Test Helpers

`test/helpers.ts` provides utilities for setting up OTel in tests:

- `createTestProvider(config?)` — Creates a `BasicTracerProvider` with `FilteringSpanProcessor` and `InMemorySpanExporter`
- `createSimpleProvider()` — Creates a provider without filtering (for baseline comparisons)
- `cleanupOtel()` — Resets global OTel state between tests. Call in `afterEach`
- `nextTick()` — Awaitable `process.nextTick` for sync span detection tests

### Key Testing Gotcha

OTel SDK v2: Use `forceFlush()` (not `shutdown()`) when reading spans from `InMemorySpanExporter`. `shutdown()` clears the exporter before you can read spans.

## CI

Pull requests and pushes to `main` run the CI workflow (`.github/workflows/ci.yml`):

- Tests on Node 22 and 24
- Build verification (ESM + CJS)
- Formatting check
- Dependency lint

All checks must pass before merging.

## Pull Request Guidelines

- Keep PRs focused on a single change
- Add tests for new features and bug fixes
- Run `npm run format` before committing
- Use descriptive PR titles — they appear in auto-generated release notes
- Label PRs to categorize them in release notes:
  - `feature` / `enhancement` — New functionality
  - `bug` / `fix` — Bug fixes
  - `breaking` — Breaking changes (triggers major version bump)
  - `docs` / `documentation` — Documentation only

Branch naming conventions auto-apply labels:

- `feat/*` or `feature/*` → `feature`
- `fix/*` → `bug`

## Release Process

Releases are automated via GitHub Actions. No manual version bumps needed.

### How it works

1. **As PRs merge**, [Release Drafter](https://github.com/release-drafter/release-drafter) maintains a draft release on GitHub with auto-generated notes categorized by PR labels

2. **When ready to release**, go to GitHub → Releases → edit the draft:
   - Review and edit the generated notes
   - The version is auto-suggested based on PR labels (breaking → major, feature → minor, fix → patch)
   - Adjust the tag if needed (e.g. `v0.3.0`)
   - Click "Publish release"

3. **On publish**, the publish workflow (`.github/workflows/publish.yml`):
   - Sets `package.json` version from the release tag
   - Runs `npm ci`, build, and tests
   - Publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) (cryptographically links the package to the source commit)

### Pre-release / beta

To publish a pre-release, create a GitHub release marked as "pre-release" with a tag like `v0.3.0-beta.1`. The publish workflow handles it the same way.
