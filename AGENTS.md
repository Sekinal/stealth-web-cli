# AGENTS.md

Instructions for AI coding agents working in this repository. Read this fully
before making changes; it encodes decisions that are easy to violate and hard
to discover from the code alone.

## Project overview

`stealth-web-cli` (package name `stealth-web-cli`, binary `stealth-web-cli`,
`playwright-cli` alias) is a stealth web-automation CLI layered on top of a
patched Playwright ("patchright-core") with swappable browser providers:

- **cloakbrowser** — default. Fingerprint-randomizing Chromium build.
- **patchright** — opt-in (`PLAYWRIGHT_CLI_BROWSER_PROVIDER=patchright`).
  Reuses Chrome for Testing; adds stealth `contextOptions` (UA override).
- **camoufox** — opt-in Firefox with anti-fingerprinting.

`playwright-cli.js` (bin) → `browserProviders.js` (provider selection/config
generation) → `cliEnhancements.js` (CLI UX: goto/fetch interception, JSON
payloads, challenge detection, solve-captcha, wait-for, retry logic).

**Upstream lineage**: most of `cliEnhancements.js` wraps code from
`node_modules/patchright-core/lib/...` (untyped, CommonJS). Match its style —
2-space indent, single quotes, JSDoc `@param` blocks with `@ts-check`, small
functions, error-swallowing only for best-effort side effects.

## Commands

```bash
npm test                  # full integration suite (Playwright; ~1.5 min)
npx playwright test tests/integration.spec.ts -g "<name>"   # filtered run
npm run lint              # eslint (must be clean before commit)
npm run lint:fix          # eslint --fix
npm run format            # prettier --write (owned code only, see .prettierignore)
npm run format:check      # prettier --check
```

CI runs `npm run lint` on every PR and the test matrix (linux/macOS/windows).
Never disable a failing test instead of fixing it.

## Testing rules (non-negotiable)

1. **Every behavioral change ships with a test** in `tests/integration.spec.ts`
   that fails on the bug you fixed. A feature without a test is not done.
2. Tests spin up local `http.createServer` fixtures — never depend on live
   external sites except the two httpbin-based header tests that already exist.
3. Use unique session names per test (`-s=<descriptive-name>`) and `close`
   the session in a `finally` block. The daemon dir is per-test via
   `PWTEST_DAEMON_SESSION_DIR`.
4. The suite runs parallel (fullyParallel) — do not share state between tests.
5. If you cannot reproduce the bug before fixing it, you have not fixed it.

## Code style

- ESLint is the authority (`npm run lint` must pass). Prettier config exists
  but is NOT enforced in CI — do not reformat files wholesale; keep diffs
  minimal so they stay comparable to upstream playwright-cli.
- CommonJS `require` everywhere (upstream compatibility). No ESM in source.
- JSDoc `@param`/`@returns` on non-trivial functions (the files carry
  `// @ts-check`).
- No `any` in new test code; upstream config objects are exempt.
- Empty `catch {}` is acceptable ONLY for best-effort side effects (metadata
  writes, best-effort probes). Errors a user cares about must propagate.
- Template literals over string concatenation. `const` over `let` unless
  reassigned. No `var`.
- No `eval`, no `Object.assign` (use spread), no `node_modules/*` imports.

## Stealth/provenance invariants (do not break)

- Provider bypass requires **invocation-level** intent only: `--browser`,
  `--config`, `PLAYWRIGHT_MCP_CONFIG`. Ambient env vars like
  `PLAYWRIGHT_MCP_BROWSER` must NOT silence provider selection (issue #28).
- Any chromium launch must not send a `HeadlessChrome` UA when a stealth
  provider is active; `contextOptions.userAgent` in generated configs is the
  guarantee.
- Provenance claims require evidence: `inferProviderDetails` may only claim
  `patchright` with stealth contextOptions present, `cloakbrowser` with a
  `--fingerprint` arg or its binary path, `camoufox` with its binary path.
- The `package identity` integration test locks name/bin/URLs — renaming
  anything requires updating that test deliberately.

## Gotchas

- `npm test` spawns real daemons; stale daemons from crashed runs are
  cleaned by the test harness, but a manually leaked daemon on
  `/tmp/pw-*/cli/*.sock` can make results confusing. `pkill -f cliDaemon`
  if in doubt.
- `playwright-cli close` per session; `close --all` is NOT a supported flag.
- The daemon reads `PLAYWRIGHT_MCP_CONFIG` from its inherited environment —
  the config tmp dir is removed when the CLI process exits.
- Tests inherit the ambient env; anything provider-related must work when
  `PLAYWRIGHT_MCP_BROWSER` is set (this is the #28 regression class).

## Commits and PRs

- Conventional commits: `fix(scope): ...`, `feat(scope): ...`, `chore: ...`,
  `test: ...`. One logical change per commit.
- Reference the issue number in the body (e.g. `Fixes #28`).
- Before committing: `npm run lint` clean + targeted tests pass + full suite
  if you touched shared code paths.

## Security

- Never log secrets (tokens, API keys). The CapSolver key flows through env
  (`CAPSOLVER_API_KEY`) and the `--captcha-api-key` flag; it must never be
  echoed into payloads or logs.
- Test scaffolds that bypass protections (mock servers, fake tokens) live
  only inside `tests/` and must not be shipped as runtime code.
