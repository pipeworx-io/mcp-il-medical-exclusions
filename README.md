# @pipeworx/il-medical-exclusions

Illinois Medicaid provider sanctions screening. Check a provider by name, NPI or
license number against the Illinois Department of Healthcare and Family Services
(HFS) Office of Inspector General Provider Sanctions list, the state-level
counterpart to the federal HHS OIG LEIE (`leie` pack) and sibling of
`tx-medical-exclusions`, `ny-omig-exclusions`, `ca-medical-exclusions` and
`fl-medical-exclusions`.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1866+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `il_medical_check_exclusion(name?, npi?, license?, limit?)`: screens a provider.
  An NPI or license match is an **identification**; a name match, even an exact
  one, is a **candidate lead only** (the list publishes no date of birth). The
  response leads with counts by action type, then the matches. Each match carries
  the action type (Terminated, Barred, Exclusion, Suspended, Voluntary
  Withdrawal), the action date, provider type and any affiliated business. A
  no-match names the filters tried.
- `il_medical_exclusion_coverage(year? | start_date? end_date?)`: totals by action
  type, NPI and license coverage, oldest and newest action date and capture date.
  With `year` or a date range it **counts** actions in that window over the whole
  list, split by action type. The counted field is `action_date` (HFS's Action
  Date), named in the response.

## Auth

Keyless.

## Data source

Illinois Department of Healthcare and Family Services, Office of Inspector
General: Provider Sanctions list (3,273 rows at capture, 1979 to date). Entities
and individuals disenrolled from the Medical Assistance Program, including
providers who voluntarily withdrew. `data_as_of` on every response is the date
the data was last refreshed.

## What the list does and does not say

- No per-record reason text and no date of birth are published.
- No reinstatement field is published, so the pack does not label anyone
  "currently sanctioned"; it reports what HFS still lists at `data_as_of`.
- `affiliation` is the business HFS ties a sanctioned individual to, when it
  records one (473 rows).

## Personal data

HFS also publishes a street address, city, state and zip for many rows. **They are
dropped at ingest and are not stored or served anywhere in this pack.** A test
asserts every baked row carries only the seven fields above. This follows the
standing rule for state exclusion packs: name plus the sanction record plus the
date, never an address for an individual.

## How the data is served

The publisher serves the list only through a search portal that needs a session
and an anti-forgery token before it will page, so a per-request proxy would be a
three-step handshake against a government site on every call. The list is copied
by `scripts/bake-index.mjs`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy and
injected as `args._bakedIndex` (never a module-scope import; fleet #2754). A
missing or malformed injection throws loudly rather than answering "not found".

Refresh: re-run `node mcps/il-medical-exclusions/scripts/bake-index.mjs` and
commit; there is no scheduled refresh yet, same as the sibling baked packs.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "il-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/il-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/il-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1866+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/il_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alrifai Tamer"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/il_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "il-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-il-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-il-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Il Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
