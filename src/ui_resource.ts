/**
 * The Alexa+ card, delivered THROUGH MCP rather than beside it.
 *
 * The hackathon rules name "media support (cards, carousels), MCP Apps, Agent
 * Skills" as the creative bar for the Alexa+ track, and list "a basic MCP wrapper
 * around an existing API" as the obvious one. `web/echo.html` was already the card
 * a device shows — it was simply being served by an HTTP static route, which any
 * web server could do. This publishes the same bytes as an MCP **resource** at a
 * `ui://` URI, so a host that implements the MCP Apps extension can render the card
 * without knowing anything about this server except the protocol.
 *
 * One file, two doors, on purpose: `GET /echo.html` for a browser and
 * `resources/read ui://unsay/echo` for a host. There is no second copy of the card
 * to drift — `uiHtml()` reads the same file `src/http.ts` serves.
 *
 * Shapes follow the stable MCP Apps specification (2026-01-26): the resource is
 * `text/html;profile=mcp-app`, and a tool names it in `_meta.ui.resourceUri`.
 * What is NOT proven, and is filed as FRICTION F-013: the card has never been
 * rendered inside a host, and it does not yet speak the host postMessage bridge the
 * spec defines — framed without a token it shows the seeded plan, not live data.
 * The resource itself is exercised: `npm run e2e` reads it over Streamable HTTP.
 */
import { readFileSync } from 'node:fs'

import type { Audience } from './types.ts'

/** The card's URI. `ui://` is the MCP Apps extension's scheme for renderable HTML. */
export const UI_ECHO_URI = 'ui://unsay/echo'

/**
 * MCP Apps (stable 2026-01-26): the one mime type a host renders in a sandboxed
 * frame, rather than text it may read aloud. A host that does not know the type
 * ignores the resource — the correct failure, and the reason the card is also on
 * an HTTP route. This was `text/html+skybridge`, the Apps SDK's type (F-013).
 */
export const UI_MIME_TYPE = 'text/html;profile=mcp-app'

/**
 * The Apps SDK's tool → template key, kept as an alias beside the standard
 * `_meta.ui.resourceUri` for hosts that predate MCP Apps (F-013).
 */
export const UI_TEMPLATE_META = 'openai/outputTemplate'

/** A tool's `_meta` naming the card: the MCP Apps key, with the Apps SDK alias. */
export const uiToolMeta = () => ({ ui: { resourceUri: UI_ECHO_URI }, [UI_TEMPLATE_META]: UI_ECHO_URI })

/** Preferred frame size, in the extension's `_meta` namespace. An Echo Show is 1280×800. */
export const UI_FRAME_META = 'mcpui.dev/ui-preferred-frame-size'

const CARD = new URL('../web/echo.html', import.meta.url)

let cached: string | null = null

/** The card's bytes. Same file `src/http.ts` serves at `/echo.html`. */
export function uiHtml(): string {
  cached ??= readFileSync(CARD, 'utf8')
  return cached
}

/** The `resources/list` entry for the card. */
export function uiResourceDescriptor() {
  return {
    uri: UI_ECHO_URI,
    name: 'Ray’s Echo Show card',
    description:
      'The 1280×800 device card: current instruction, the retracted line struck through, ' +
      'and who changed it. Renderable HTML, not text to be spoken.',
    mimeType: UI_MIME_TYPE,
    annotations: { audience: ['user', 'assistant'] as Audience[], priority: 0.5 },
    _meta: { [UI_FRAME_META]: ['1280px', '800px'] },
  }
}
