/**
 * GraphQL-to-REST proxy for the Wildcat indexer.
 *
 * Intercepts GraphQL queries that would normally go to the Goldsky subgraph,
 * translates them into REST calls to our Rust API, and returns the response
 * in the subgraph's expected shape. Queries not yet handled fall through to
 * the actual subgraph.
 */
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"

const INDEXER_URL =
  process.env.WILDCAT_INDEXER_URL || "http://localhost:8080/v1/wildcat"
const CHAIN_ID = process.env.WILDCAT_INDEXER_CHAIN_ID || "1"

const SUBGRAPH_FALLBACK_URL =
  "https://api.goldsky.com/api/public/project_cmheai1ym00jyx7p27qn46qtm/subgraphs/mainnet/v2.0.22/gn"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function indexerGet(path: string): Promise<unknown> {
  const resp = await fetch(`${INDEXER_URL}${path}`, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  })
  if (!resp.ok) throw new Error(`Indexer ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

function extractOperationName(query: string): string | null {
  const match = query.match(/query\s+(\w+)/)
  return match ? match[1] : null
}

function wrapData(data: unknown) {
  return NextResponse.json({ data })
}

// ---------------------------------------------------------------------------
// Query handlers — each returns the subgraph-shaped data
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>

async function handleGetBasicBorrowerData(vars: Variables) {
  const borrower = (vars.borrower as string).toLowerCase()
  const data = (await indexerGet(
    `/borrowers/${CHAIN_ID}/${borrower}`,
  )) as Record<string, unknown>

  return {
    registeredBorrowers: [{ isRegistered: data.isRegistered ?? false }],
    markets:
      (data.marketIds as string[] | undefined)?.map((id) => ({ id })) ??
      Array.from({ length: data.marketCount as number }, () => ({})),
  }
}

async function handleGetAllMarkets() {
  const data = (await indexerGet(`/markets/${CHAIN_ID}?limit=1000`)) as {
    markets: Record<string, unknown>[]
  }
  return { markets: data.markets }
}

async function handleGetAllTokensWithMarkets() {
  const data = (await indexerGet(`/tokens/${CHAIN_ID}?limit=200`)) as {
    tokens: Record<string, unknown>[]
  }
  return { tokens: data.tokens }
}

async function handleGetMarket(vars: Variables) {
  const market = (vars.market as string).toLowerCase()
  const data = (await indexerGet(`/markets/${CHAIN_ID}/${market}`)) as {
    market: Record<string, unknown>
  }
  return { market: data.market }
}

async function handleGetMarketsWithEvents(vars: Variables) {
  const borrower = vars.borrower
    ? `&borrower=${(vars.borrower as string).toLowerCase()}`
    : ""
  const data = (await indexerGet(
    `/markets/${CHAIN_ID}?include_events=true&event_limit=3${borrower}&limit=1000`,
  )) as { markets: Record<string, unknown>[] }
  return { markets: data.markets }
}

async function handleGetAllMarketsForLenderView(vars: Variables) {
  const lender = (vars.lender as string).toLowerCase()
  const data = (await indexerGet(
    `/lenders/${CHAIN_ID}/${lender}/markets?limit=1000`,
  )) as { markets: Record<string, unknown>[] }
  return { markets: data.markets, controllerAuthorizations: [] }
}

async function handleGetLenderAccountForMarket(vars: Variables) {
  const market = (vars.market as string).toLowerCase()
  const lender = (vars.lender as string).toLowerCase()
  const resp = await fetch(
    `${INDEXER_URL}/markets/${CHAIN_ID}/${market}/lenders/${lender}`,
    { headers: { Accept: "application/json" }, next: { revalidate: 0 } },
  )
  if (resp.status === 404) {
    const marketData = await handleGetMarket({ market } as Variables)
    return { market: { ...(marketData as { market: object }).market, lenders: [] } }
  }
  if (!resp.ok) throw new Error(`Indexer ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

async function handleGetActiveLendersByMarket(vars: Variables) {
  const market = (vars.market as string).toLowerCase()
  const data = (await indexerGet(
    `/markets/${CHAIN_ID}/${market}/active-lenders?limit=1000`,
  )) as { lenders: Record<string, unknown>[] }
  return { market: { lenders: data.lenders } }
}

async function handleGetLenderWithdrawalsForMarket(vars: Variables) {
  const market = (vars.market as string).toLowerCase()
  const lender = (vars.lender as string).toLowerCase()
  const data = (await indexerGet(
    `/markets/${CHAIN_ID}/${market}/lenders/${lender}/withdrawal-details?limit=200`,
  )) as Record<string, unknown>
  return data
}

async function handleGetAllHooksDataForBorrower(vars: Variables) {
  const borrower = (vars.borrower as string).toLowerCase()
  const data = (await indexerGet(
    `/borrowers/${CHAIN_ID}/${borrower}/hooks`,
  )) as Record<string, unknown>
  return data
}

async function handleGetMarketRecords(vars: Variables) {
  const market = (vars.market as string).toLowerCase()
  const limit = vars.limit ?? 500
  const data = (await indexerGet(
    `/markets/${CHAIN_ID}/${market}?include_records=true&record_limit=${limit}`,
  )) as { market: Record<string, unknown> }
  return { market: data.market }
}

async function handleGetLendersByHooksInstanceOrController(vars: Variables) {
  const id = ((vars.hooks || vars.controller) as string).toLowerCase()
  const isHooks = !!vars.hooks
  const path = isHooks
    ? `/hooks/${CHAIN_ID}/${id}/lenders?limit=200`
    : `/controllers/${CHAIN_ID}/${id}/lenders?limit=200`
  const data = (await indexerGet(path)) as Record<string, unknown>
  return data
}

async function handleGetMarketsAndLendersByHooksInstanceOrController(
  vars: Variables,
) {
  const id = ((vars.hooks || vars.controller) as string).toLowerCase()
  const isHooks = !!vars.hooks
  const path = isHooks
    ? `/hooks/${CHAIN_ID}/${id}/markets-and-lenders?limit=200`
    : `/controllers/${CHAIN_ID}/${id}/markets-and-lenders?limit=200`
  const data = (await indexerGet(path)) as Record<string, unknown>
  return data
}

// Event polling handler — maps Apollo gql queries to the unified events endpoint
async function handleEventQuery(
  eventType: string,
  vars: Variables,
): Promise<Record<string, unknown[]>> {
  const where = (vars.where ?? {}) as Record<string, unknown>
  const params = new URLSearchParams()
  params.set("event_type", eventType)
  params.set("limit", "500")

  if (where.blockTimestamp_gt) {
    params.set("since_timestamp", String(where.blockTimestamp_gt))
  }

  // eslint-disable-next-line no-underscore-dangle
  const marketFilter = where.market_ as Record<string, unknown> | undefined
  if (marketFilter?.id_in) {
    params.set("markets", (marketFilter.id_in as string[]).join(","))
  }

  // borrower filter
  if (where.borrower) {
    params.set("borrower", String(where.borrower))
  }

  // lender filter
  if (where.lender) {
    params.set("lender", String(where.lender))
  }

  const data = (await indexerGet(
    `/events/${CHAIN_ID}?${params.toString()}`,
  )) as { events: Record<string, unknown>[] }

  return { events: data.events }
}

// ---------------------------------------------------------------------------
// Subgraph query → event type mapping (for polling queries)
// ---------------------------------------------------------------------------

const POLLING_QUERY_MAP: Record<string, string> = {
  // These aren't SDK operation names — they're the root field names
  // from the Apollo gql queries in src/graphql/queries.ts
  borrows: "Borrow",
  debtRepaids: "DebtRepaid",
  deposits: "Deposit",
  withdrawalBatchCreateds: "WithdrawalBatchCreated",
  withdrawalBatchExpireds: "WithdrawalBatchExpired",
  withdrawalExecutions: "WithdrawalExecuted",
  marketCloseds: "MarketClosed",
  reserveRatioBipsUpdateds: "ReserveRatioBipsUpdated",
  borrowerRegistrationChanges: "BorrowerRegistrationChange",
  lenderAuthorizationChanges: "LenderAuthorizationChange",
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const QUERY_HANDLERS: Record<string, (vars: Variables) => Promise<unknown>> = {
  getBasicBorrowerData: handleGetBasicBorrowerData,
  getAllMarkets: handleGetAllMarkets,
  getAllTokensWithMarkets: handleGetAllTokensWithMarkets,
  getMarket: handleGetMarket,
  getMarketsWithEvents: handleGetMarketsWithEvents,
  getAllMarketsForLenderView: handleGetAllMarketsForLenderView,
  getLenderAccountForMarket: handleGetLenderAccountForMarket,
  getLenderAccountWithMarket: handleGetLenderAccountForMarket,
  getActiveLendersByMarket: handleGetActiveLendersByMarket,
  getLenderWithdrawalsForMarket: handleGetLenderWithdrawalsForMarket,
  getAllHooksDataForBorrower: handleGetAllHooksDataForBorrower,
  getAllHooksTemplates: handleGetAllHooksDataForBorrower,
  getHooksInstancesForBorrower: handleGetAllHooksDataForBorrower,
  getMarketRecords: handleGetMarketRecords,
  getMarketEvents: handleGetMarketRecords,
  getLendersByHooksInstanceOrController:
    handleGetLendersByHooksInstanceOrController,
  getMarketsAndLendersByHooksInstanceOrController:
    handleGetMarketsAndLendersByHooksInstanceOrController,
}

async function fallbackToSubgraph(body: string): Promise<NextResponse> {
  const resp = await fetch(SUBGRAPH_FALLBACK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  })
  const data = await resp.json()
  return NextResponse.json(data, { status: resp.status })
}

export async function POST(request: NextRequest) {
  const body = await request.text()
  let parsed: { query: string; variables?: Variables }
  try {
    parsed = JSON.parse(body)
  } catch {
    return NextResponse.json(
      { errors: [{ message: "Invalid JSON" }] },
      { status: 400 },
    )
  }

  const { query, variables = {} } = parsed

  // Try named operation first
  const opName = extractOperationName(query)
  if (opName && QUERY_HANDLERS[opName]) {
    try {
      const data = await QUERY_HANDLERS[opName](variables)
      return wrapData(data)
    } catch (err) {
      console.error(`[subgraph-proxy] ${opName} failed, falling back:`, err)
      return fallbackToSubgraph(body)
    }
  }

  // Try matching polling queries by root field name
  const matchedEntry = Object.entries(POLLING_QUERY_MAP).find(([field]) =>
    query.includes(field),
  )
  if (matchedEntry) {
    const [field, eventType] = matchedEntry
    try {
      const result = await handleEventQuery(eventType, variables)
      return wrapData({ [field]: result.events })
    } catch (err) {
      console.error(
        `[subgraph-proxy] event ${field} failed, falling back:`,
        err,
      )
      return fallbackToSubgraph(body)
    }
  }

  // _meta query for subgraph status
  if (query.includes("_meta")) {
    return wrapData({
      _meta: {
        block: { number: 0 },
        deployment: "indexer-proxy",
        hasIndexingErrors: false,
      },
    })
  }

  // Not recognized — fall through to actual subgraph
  console.log(`[subgraph-proxy] unhandled query: ${opName ?? "(anonymous)"}`)
  return fallbackToSubgraph(body)
}
