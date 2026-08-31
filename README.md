# stealth-web-cli

Stealth Browser CLI with SKILLS

### Stealth Browser CLI vs Playwright MCP

This package provides CLI interface into Playwright. If you are using **coding agents**, that is the best fit.

- **CLI**: Modern **coding agents** increasingly favor CLI–based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient: they avoid loading large tool schemas and verbose accessibility trees into the model context, allowing agents to act through concise, purpose-built commands. This makes CLI + SKILLs better suited for high-throughput coding agents that must balance browser automation with large codebases, tests, and reasoning within limited context windows.

- **MCP**: MCP remains relevant for specialized agentic loops that benefit from persistent state, rich introspection, and iterative reasoning over page structure, such as exploratory automation, self-healing tests, or long-running autonomous workflows where maintaining continuous browser context outweighs token cost concerns. Learn more about [Playwright MCP](https://github.com/microsoft/playwright-mcp).

### Key Features

- **Token-efficient**. Does not force page data into LLM.

### Requirements
- Node.js 20 or newer
- Claude Code, GitHub Copilot, or any other coding agent.

## Getting Started

## Installation

```bash
npm install -g stealth-web-cli
stealth-web-cli --help
```

### Installing skills

Claude Code, GitHub Copilot and others will use the locally installed skills.

```bash
stealth-web-cli install --skills
```

### Skills-less operation

Point your agent at the CLI and let it cook. It'll read the skill off `stealth-web-cli --help` on its own:

```
Test the "add todo" flow on https://demo.playwright.dev/todomvc using stealth-web-cli.
Check stealth-web-cli --help for available commands.
```

## Demo

```
> Use playwright skills to test https://demo.playwright.dev/todomvc/.
  Take screenshots for all successful and failing scenarios.
```

Your agent will be running commands, but it does not mean you can't play with it manually:

```
stealth-web-cli open https://demo.playwright.dev/todomvc/ --headed
stealth-web-cli type "Buy groceries"
stealth-web-cli press Enter
stealth-web-cli type "Water flowers"
stealth-web-cli press Enter
stealth-web-cli check e21
stealth-web-cli check e35
stealth-web-cli screenshot
```

## Headed operation

Stealth Browser CLI is headless by default. If you'd like to see the browser, pass `--headed` to `open`:

```bash
stealth-web-cli open https://playwright.dev --headed
```

## Sessions

Stealth Browser CLI keeps the browser profile in memory by default. Your cookies and storage state
are preserved between CLI calls within the session, but lost when the browser closes. Use
`--persistent` to save the profile to disk for persistence across browser restarts.

You can use different instances of the browser for different projects with sessions. Pass `-s=` to
the invocation to talk to a specific browser.

```bash
stealth-web-cli open https://playwright.dev
stealth-web-cli -s=example open https://example.com --persistent
stealth-web-cli list
```

For login-walled sites, keep a named persistent session so cookies survive browser restarts. After
finishing a manual login in headed mode, save a portable storage-state backup as well:

```bash
stealth-web-cli -s=social open https://example.com/login --headed --persistent
# complete the login in the browser window, then:
stealth-web-cli -s=social state-save auth.json
# later, reuse the persistent session or restore the backup with state-load auth.json
```

You can run your coding agent with the `PLAYWRIGHT_CLI_SESSION` environment variable:

```bash
PLAYWRIGHT_CLI_SESSION=todo-app claude .
```

Or instruct it to prepend `-s=` to the calls.

Manage your sessions as follows:

```bash
stealth-web-cli list                     # list all sessions
stealth-web-cli close-all                # close all browsers
stealth-web-cli kill-all                 # forcefully kill all browser processes
```

## Monitoring

Use `stealth-web-cli show` to open a visual dashboard that lets you see and control all running
browser sessions. This is useful when your coding agents are running browser automation in the
background and you want to observe their progress or step in to help.

```bash
stealth-web-cli show
```

<img width="1107" height="729" alt="Image" src="https://github.com/user-attachments/assets/99df739d-106a-4520-b004-bb315db41da7" />

The dashboard opens a window with two views:

- **Session grid** — shows all active sessions grouped by workspace, each with a live screencast
  preview, session name, current URL, and page title. Click any session to zoom in.
- **Session detail** — shows a live view of the selected session with a tab bar, navigation
  controls (back, forward, reload, address bar), and full remote control. Click into the viewport
  to take over mouse and keyboard input; press Escape to release.

From the grid you can also close running sessions or delete data for inactive ones.

## Commands

### Core

```bash
stealth-web-cli open [url]               # open browser, optionally navigate to url
stealth-web-cli goto <url>               # navigate to a url
stealth-web-cli goto <url> --timeout=5   # navigate with an explicit timeout in seconds
stealth-web-cli close                    # close the page
stealth-web-cli type <text>              # type text into editable element
stealth-web-cli click <ref> [button]     # perform click on a web page
stealth-web-cli dblclick <ref> [button]  # perform double click on a web page
stealth-web-cli fill <ref> <text>        # fill text into editable element
stealth-web-cli fill <ref> <text> --submit # fill and press Enter
stealth-web-cli drag <startRef> <endRef> # perform drag and drop between two elements
stealth-web-cli drop <ref> --path=<file> # drop files onto an element (from outside the page)
stealth-web-cli drop <ref> --data="k=v"  # drop data onto an element
stealth-web-cli hover <ref>              # hover over element on page
stealth-web-cli select <ref> <val>       # select an option in a dropdown
stealth-web-cli upload <file>            # upload one or multiple files
stealth-web-cli check <ref>              # check a checkbox or radio button
stealth-web-cli uncheck <ref>            # uncheck a checkbox or radio button
stealth-web-cli snapshot                 # capture page snapshot to obtain element ref
stealth-web-cli snapshot --filename=f    # save snapshot to specific file
stealth-web-cli snapshot --inline        # return snapshot content directly
stealth-web-cli snapshot <ref>           # snapshot a specific element
stealth-web-cli snapshot --depth=N       # limit snapshot depth for efficiency
stealth-web-cli eval <func> [ref]        # evaluate javascript expression on page or element
stealth-web-cli eval <func> --output=f   # save the raw evaluation value to an absolute file path
stealth-web-cli dialog-accept [prompt]   # accept a dialog
stealth-web-cli dialog-dismiss           # dismiss a dialog
stealth-web-cli resize <w> <h>           # resize the browser window
```

### Navigation

```bash
stealth-web-cli go-back                  # go back to the previous page
stealth-web-cli go-forward               # go forward to the next page
stealth-web-cli reload                   # reload the current page
```

### Keyboard

```bash
stealth-web-cli press <key>              # press a key on the keyboard, `a`, `arrowleft`
stealth-web-cli keydown <key>            # press a key down on the keyboard
stealth-web-cli keyup <key>              # press a key up on the keyboard
```

### Mouse

```bash
stealth-web-cli mousemove <x> <y>        # move mouse to a given position
stealth-web-cli mousedown [button]       # press mouse down
stealth-web-cli mouseup [button]         # press mouse up
stealth-web-cli mousewheel <dx> <dy>     # scroll mouse wheel
```

### Save as

```bash
stealth-web-cli screenshot [ref]         # screenshot of the current page or element
stealth-web-cli screenshot --filename=f  # save screenshot with specific filename
stealth-web-cli pdf                      # save page as pdf
stealth-web-cli pdf --filename=page.pdf  # save pdf with specific filename
```

### Tabs

```bash
stealth-web-cli tab-list                 # list all tabs
stealth-web-cli tab-new [url]            # create a new tab
stealth-web-cli tab-close [index]        # close a browser tab
stealth-web-cli tab-select <index>       # select a browser tab
```

### Storage

```bash
stealth-web-cli state-save [filename]    # save storage state
stealth-web-cli state-load <filename>    # load storage state

# Cookies
stealth-web-cli cookie-list [--domain]   # list cookies
stealth-web-cli cookie-get <name>        # get a cookie
stealth-web-cli cookie-set <name> <val>  # set a cookie
stealth-web-cli cookie-delete <name>     # delete a cookie
stealth-web-cli cookie-clear             # clear all cookies

# LocalStorage
stealth-web-cli localstorage-list        # list localStorage entries
stealth-web-cli localstorage-get <key>   # get localStorage value
stealth-web-cli localstorage-set <k> <v> # set localStorage value
stealth-web-cli localstorage-delete <k>  # delete localStorage entry
stealth-web-cli localstorage-clear       # clear all localStorage

# SessionStorage
stealth-web-cli sessionstorage-list      # list sessionStorage entries
stealth-web-cli sessionstorage-get <k>   # get sessionStorage value
stealth-web-cli sessionstorage-set <k> <v> # set sessionStorage value
stealth-web-cli sessionstorage-delete <k>  # delete sessionStorage entry
stealth-web-cli sessionstorage-clear     # clear all sessionStorage
```

### Network

```bash
stealth-web-cli route <pattern> [opts]   # mock network requests
stealth-web-cli route-list               # list active routes
stealth-web-cli unroute [pattern]        # remove route(s)
```

### HTTP requests

```bash
stealth-web-cli fetch <url> [opts]       # raw body on stdout, composes with jq
  --method=GET|POST|PUT|PATCH|DELETE|HEAD   HTTP method (default GET)
  --data=<body>                             request body
  --header="Key: Value"                     request header (comma-separated)
  --timeout=<seconds> / --retry=<N>         timeout and retries on 5xx/network
  --engine=wreq|httpcloak|browser           transport engine (default wreq)
```

`fetch` runs through fingerprint-matched plain-HTTP engines — `node-wreq` (TLS JA3/JA4 + HTTP2, the
[wreq](https://wreq.org) successor to rquest) and `httpcloak` (managed Chrome/Edge/Firefox presets) —
so no browser session is needed for static targets. The default `wreq` engine escalates to the
CloakBrowser session automatically when a challenge is detected; challenge-heavy or JS-rendered pages
therefore require an open session (`open`). `--engine=browser` rides CloakBrowser's own network
stack. `eval` and `tab-*` stay browser-only.

### Scraping

```bash
stealth-web-cli scrape <url> [opts]     # render a page (or crawl) and emit structured output
  --crawl                                 follow same-origin links
  --max-requests=<N>                      max pages (default 1, or 20 with --crawl)
  --max-depth=<N>                         max link depth with --crawl
  --same-origin=true|false                only follow same-hostname links (default true)
  --concurrency=<N> / --requests-per-minute=<N>  parallel pages / rate limit
  --select=<css>                          extract elements matching a selector
  --schema=<json-file>                    extract fields: { field: { selector, attr?, all? } }
  --output-format=json|text|markdown|csv  output format (default json)
  --output=<file>                         write output to a file
  --timeout=<seconds> / --retry=<N>       per-page timeout and retries (default 60 / 3)
```

`scrape` renders pages through the CloakBrowser provider via [Crawlee](https://crawlee.dev), giving
retry-aware, rate-limited crawling with request deduplication. Each result reports `attempts` and
`retried`; challenge pages (403/429 or Cloudflare/reCAPTCHA markers) are retried (and auto-solved via
`CAPSOLVER_API_KEY` when present), then surfaced as `challenge` with content redacted and a nonzero
exit — never captured as content. Use `--select`/`--schema` for field extraction, then pipe
`--output-format=csv` into your data pipeline.

### DevTools

```bash
stealth-web-cli console [min-level]      # list console messages
stealth-web-cli requests                 # list all network requests since loading the page
stealth-web-cli request <index>          # show details for a specific request
stealth-web-cli run-code <code>          # run playwright code snippet
stealth-web-cli run-code --filename=f    # run playwright code from a file
stealth-web-cli tracing-start            # start trace recording
stealth-web-cli tracing-stop             # stop trace recording
stealth-web-cli video-start [filename]   # start video recording
stealth-web-cli video-chapter <title>    # add a chapter marker to the video
stealth-web-cli video-show-actions       # annotate each action with a callout in the video
stealth-web-cli video-hide-actions       # stop annotating actions in the video
stealth-web-cli video-stop               # stop video recording
stealth-web-cli show                     # open the visual dashboard
stealth-web-cli show --annotate          # launch dashboard for UI review / design feedback
stealth-web-cli generate-locator <ref>   # generate a playwright locator for an element
stealth-web-cli highlight <ref>          # show a persistent highlight overlay
stealth-web-cli highlight <ref> --style= # highlight with a custom CSS style
stealth-web-cli highlight <ref> --hide   # hide highlight on a specific element
stealth-web-cli highlight --hide         # hide all page highlights
```

### Open parameters

```bash
stealth-web-cli open --browser=chrome    # use specific browser
stealth-web-cli attach --extension=chrome # connect via Playwright Extension
stealth-web-cli attach --cdp=chrome      # attach to running Chrome/Edge by channel
stealth-web-cli attach --cdp=<url>       # attach via CDP endpoint
stealth-web-cli detach                   # detach an attached session, leaves the external browser running
stealth-web-cli open --persistent        # use persistent profile
stealth-web-cli open --profile=<path>    # use custom profile directory
stealth-web-cli open --config=file.json  # use config file
stealth-web-cli close                    # close the browser
stealth-web-cli delete-data              # delete user data for default session
```

CloakBrowser is the sole browser provider; it is selected by default (set
`PLAYWRIGHT_CLI_BROWSER_PROVIDER=cloakbrowser`, or omit it, for the same result). The `patchright`
and `camoufox` providers were removed and are rejected with a clear error. Explicit invocation-level
`--browser`, `--config`, and `PLAYWRIGHT_MCP_CONFIG` settings are respected and skip the automatic
provider selection. Ambient upstream environment variables such as `PLAYWRIGHT_MCP_BROWSER` do not
skip stealth selection: they are frequently set system-wide for other tools and would otherwise
silently launch a stock headless Chromium whose user agent leaks `HeadlessChrome` (issue #28).

Every `open` reports the selected provider and installed provider version. Opening an already-running
session restarts it and re-evaluates the configured provider; `list` reports the provider name
instead of the generic browser channel. When a session's provider sidecar is missing, the name is
recovered only when the session file still carries a CloakBrowser stealth marker (`--fingerprint`
argument or its binary path); otherwise the generic channel is reported. An explicit
`PLAYWRIGHT_CLI_BROWSER_PROVIDER` takes precedence over conflicting upstream browser environment
variables.

### Structured output

Pass `--json` to any command for a deterministic response. Page commands return `ok`, `url`, `title`,
`result`, `console`, and `provider`. `provider` contains the active provider and version for managed
sessions and is `null` when provider selection was bypassed. Failures use the same schema, include an
`error`, and exit nonzero.

```json
{
  "provider": { "name": "cloakbrowser", "version": "0.5.3" }
}
```

```bash
stealth-web-cli goto https://example.com --timeout=5 --json
stealth-web-cli eval '() => document.title' --json
```

Use `eval --output=<file>` when the result is too large for terminal output. String results are written
literally, with real newlines and no JSON quoting; objects and other JSON values retain readable JSON.
The result link contains the absolute output path. Upstream-compatible `--filename=<file>` remains
available when a JSON-serialized file is desired.

### Snapshots

After each command, stealth-web-cli provides a snapshot of the current browser state.

```bash
> stealth-web-cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

You can also take a snapshot on demand using `stealth-web-cli snapshot` command. All the options below can be combined as needed.

```bash
# default - save to a file with timestamp-based name
stealth-web-cli snapshot

# save to file, use when snapshot is a part of the workflow result
stealth-web-cli snapshot --filename=after-click.yaml

# return snapshot content inline (especially useful with --json)
stealth-web-cli snapshot --inline --json

# snapshot an element instead of the whole page
stealth-web-cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
stealth-web-cli snapshot --depth=4
stealth-web-cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
stealth-web-cli snapshot --boxes
```

### Targeting elements

By default, use refs from the snapshot to interact with page elements.

```bash
# get snapshot with refs
stealth-web-cli snapshot

# interact using a ref
stealth-web-cli click e15
```

You can also use css selectors or Playwright locators.

```bash
# css selector
stealth-web-cli click "#main > button.submit"

# role locator
stealth-web-cli click "getByRole('button', { name: 'Submit' })"

# test id
stealth-web-cli click "getByTestId('submit-button')"
```

### Sessions

```bash
stealth-web-cli -s=name <cmd>            # run command in named session
stealth-web-cli -s=name close            # stop a named browser
stealth-web-cli -s=name delete-data      # delete user data for named browser
stealth-web-cli list                     # list all sessions
stealth-web-cli close-all                # close all browsers
stealth-web-cli kill-all                 # forcefully kill all browser processes
```

### Local installation

If global `stealth-web-cli` command is not available, try a local version via `npx stealth-web-cli`:

```bash
npx --no-install stealth-web-cli --version
```

When local version is available, use `npx stealth-web-cli` in all commands. Otherwise, install `stealth-web-cli` as a global command:

```bash
npm install -g stealth-web-cli
```

## Configuration file

The Stealth Browser CLI can be configured using a JSON configuration file. You can specify the configuration file using the `--config` command line option:

```bash
stealth-web-cli --config path/to/config.json open example.com
```

Stealth Browser CLI will load config from `.playwright/cli.config.json` by default so that you did not need to specify it every time.

<details>
<summary>Configuration file schema</summary>

```typescript
{
  /**
   * The browser to use.
   */
  browser?: {
    /**
     * The type of browser to use.
     */
    browserName?: 'chromium' | 'firefox' | 'webkit';

    /**
     * Keep the browser profile in memory, do not save it to disk.
     */
    isolated?: boolean;

    /**
     * Path to a user data directory for browser profile persistence.
     * Temporary directory is created by default.
     */
    userDataDir?: string;

    /**
     * Launch options passed to
     * @see https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
     *
     * This is useful for settings options like `channel`, `headless`, `executablePath`, etc.
     */
    launchOptions?: playwright.LaunchOptions;

    /**
     * Context options for the browser context.
     *
     * This is useful for settings options like `viewport`.
     */
    contextOptions?: playwright.BrowserContextOptions;

    /**
     * Chrome DevTools Protocol endpoint to connect to an existing browser instance in case of Chromium family browsers.
     */
    cdpEndpoint?: string;

    /**
     * CDP headers to send with the connect request.
     */
    cdpHeaders?: Record<string, string>;

    /**
     * Timeout in milliseconds for connecting to CDP endpoint. Defaults to 30000 (30 seconds). Pass 0 to disable timeout.
     */
    cdpTimeout?: number;

    /**
     * Remote endpoint to connect to an existing Playwright server.
     */
    remoteEndpoint?: string;

    /**
     * Paths to TypeScript files to add as initialization scripts for Playwright page.
     */
    initPage?: string[];

    /**
     * Paths to JavaScript files to add as initialization scripts.
     * The scripts will be evaluated in every page before any of the page's scripts.
     */
    initScript?: string[];
  },

  /**
   * If specified, saves the Playwright video of the session into the output directory.
   */
  saveVideo?: {
    width: number;
    height: number;
  };

  /**
   * The directory to save output files.
   */
  outputDir?: string;

  /**
   * Whether to save snapshots, console messages, network logs and other session logs to a file or to the standard output. Defaults to "stdout".
   */
  outputMode?: 'file' | 'stdout';

  console?: {
    /**
     * The level of console messages to return. Each level includes the messages of more severe levels. Defaults to "info".
     */
    level?: 'error' | 'warning' | 'info' | 'debug';
  },

  network?: {
    /**
     * List of origins to allow the browser to request. Default is to allow all. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     */
    allowedOrigins?: string[];

    /**
     * List of origins to block the browser to request. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     */
    blockedOrigins?: string[];
  };

  /**
   * Specify the attribute to use for test ids, defaults to "data-testid".
   */
  testIdAttribute?: string;

  timeouts?: {
    /*
     * Configures default action timeout: https://playwright.dev/docs/api/class-page#page-set-default-timeout. Defaults to 5000ms.
     */
    action?: number;

    /*
     * Configures default navigation timeout: https://playwright.dev/docs/api/class-page#page-set-default-navigation-timeout. Defaults to 60000ms.
     */
    navigation?: number;
  };

  /**
   * Whether to allow file uploads from anywhere on the file system.
   * By default (false), file uploads are restricted to paths within the MCP roots only.
   */
  allowUnrestrictedFileAccess?: boolean;

  /**
   * Specify the language to use for code generation.
   */
  codegen?: 'typescript' | 'none';
}
```

</details>

<details>
<summary>Configuration via env</summary>

| Environment |
|-------------|
| `PLAYWRIGHT_MCP_ALLOWED_HOSTS` comma-separated list of hosts this server is allowed to serve from. Defaults to the host the server is bound to. Pass '*' to disable the host check. |
| `PLAYWRIGHT_MCP_ALLOWED_ORIGINS` semicolon-separated list of TRUSTED origins to allow the browser to request. Default is to allow all. Important: *does not* serve as a security boundary and *does not* affect redirects. |
| `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS` allow access to files outside of the workspace roots. Also allows unrestricted access to file:// URLs. By default access to file system is restricted to workspace root directories (or cwd if no roots are configured) only, and navigation to file:// URLs is blocked. |
| `PLAYWRIGHT_MCP_BLOCKED_ORIGINS` semicolon-separated list of origins to block the browser from requesting. Blocklist is evaluated before allowlist. If used without the allowlist, requests not matching the blocklist are still allowed. Important: *does not* serve as a security boundary and *does not* affect redirects. |
| `PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS` block service workers |
| `PLAYWRIGHT_MCP_BROWSER` browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge. |
| `PLAYWRIGHT_MCP_CAPS` comma-separated list of additional capabilities to enable, possible values: vision, pdf. |
| `PLAYWRIGHT_MCP_CDP_ENDPOINT` CDP endpoint to connect to. |
| `PLAYWRIGHT_MCP_CDP_HEADERS` CDP headers to send with the connect request, multiple can be specified. |
| `PLAYWRIGHT_MCP_CDP_TIMEOUT` timeout for the CDP connection. |
| `PLAYWRIGHT_MCP_CONFIG` path to the configuration file. |
| `PLAYWRIGHT_MCP_CONSOLE_LEVEL` level of console messages to return: "error", "warning", "info", "debug". Each level includes the messages of more severe levels. |
| `PLAYWRIGHT_MCP_DEVICE` device to emulate, for example: "iPhone 15" |
| `PLAYWRIGHT_MCP_EXECUTABLE_PATH` path to the browser executable. |
| `PLAYWRIGHT_MCP_EXTENSION` Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright MCP Bridge" browser extension to be installed. |
| `PLAYWRIGHT_MCP_GRANT_PERMISSIONS` List of permissions to grant to the browser context, for example "geolocation", "clipboard-read", "clipboard-write". |
| `PLAYWRIGHT_MCP_HEADLESS` whether to run browser in headless mode, headless by default. |
| `PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS` ignore https errors |
| `PLAYWRIGHT_MCP_INIT_PAGE` path to TypeScript file to evaluate on Playwright page object |
| `PLAYWRIGHT_MCP_INIT_SCRIPT` path to JavaScript file to add as an initialization script. The script will be evaluated in every page before any of the page's scripts. Can be specified multiple times. |
| `PLAYWRIGHT_MCP_ISOLATED` keep the browser profile in memory, do not save it to disk. |
| `PLAYWRIGHT_MCP_SANDBOX` whether to enable the browser sandbox. |
| `PLAYWRIGHT_MCP_OUTPUT_DIR` path to the directory for output files. |
| `PLAYWRIGHT_MCP_PROXY_BYPASS` comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com" |
| `PLAYWRIGHT_MCP_PROXY_SERVER` specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080" |
| `PLAYWRIGHT_MCP_SAVE_TRACE` Whether to save the Playwright Trace of the session into the output directory. |
| `PLAYWRIGHT_MCP_SAVE_VIDEO` Whether to save the video of the session into the output directory. For example "--save-video=800x600" |
| `PLAYWRIGHT_MCP_SECRETS_FILE` path to a file containing secrets in the dotenv format |
| `PLAYWRIGHT_MCP_STORAGE_STATE` path to the storage state file for isolated sessions. |
| `PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE` specify the attribute to use for test ids, defaults to "data-testid" |
| `PLAYWRIGHT_MCP_TIMEOUT_ACTION` specify action timeout in milliseconds, defaults to 5000ms |
| `PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION` specify navigation timeout in milliseconds, defaults to 60000ms |
| `PLAYWRIGHT_MCP_USER_AGENT` specify user agent string |
| `PLAYWRIGHT_MCP_USER_DATA_DIR` path to the user data directory. If not specified, a temporary directory will be created. |
| `PLAYWRIGHT_MCP_VIEWPORT_SIZE` specify browser viewport size in pixels, for example "1280x720" |
</details>

## Specific tasks

The installed skill includes detailed reference guides for common tasks:

* **Running and Debugging Playwright tests** — run, debug and manage Playwright test suites
* **Request mocking** — intercept and mock network requests
* **Running Playwright code** — execute arbitrary Playwright scripts
* **Browser session management** — manage multiple browser sessions
* **Storage state (cookies, localStorage)** — persist and restore browser state
* **Test generation (plan / generate / heal)** — generate Playwright tests from a spec or interactions
* **Tracing** — record and inspect execution traces
* **Video recording** — capture browser session videos
* **Inspecting element attributes** — get element id, class, or any attribute not visible in the snapshot
