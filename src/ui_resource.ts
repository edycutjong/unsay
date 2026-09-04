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
 * What is NOT proven here, and is filed as FRICTION F-013: no host we can reach
 * implements the extension, so the `_meta` template binding below is shaped and
 * unexercised — the same posture as the KMS provider (F-004). The resource itself
 * is exercised: `npm run e2e` reads it over Streamable HTTP and asserts the bytes.
 */
import { readFileSync } from 'node:fs'

import type { Audience } from './types.ts'

/** The card's URI. `ui://` is the MCP Apps extension's scheme for renderable HTML. */
export const UI_ECHO_URI = 'ui://unsay/echo'

/**
 * The mime type the MCP Apps extension uses to mark HTML a host may render in a
 * sandboxed frame, rather than text it may read aloud. A host that does not know
 * the type sees an unknown mime type and ignores the resource — which is the
 * correct failure, and the reason the card is also on an HTTP route.
 */
export const UI_MIME_TYPE = 'text/html+skybridge'

/**
 * The key that binds a tool result to a template. It carries a vendor prefix
 * inherited from the Apps SDK rather than a `mcp/` one, which is exactly the thing
 * FRICTION F-013 asks the extension to settle before servers commit to it. Named
 * here once so there is a single place to change when it is settled.
 */
export const UI_TEMPLATE_META = 'openai/outputTemplate'

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
