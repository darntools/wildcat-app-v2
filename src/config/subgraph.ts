import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  LazyQueryHookOptions,
  NormalizedCacheObject,
} from "@apollo/client"
import {
  getSubgraphClient as sdkGetSubgraphClient,
  SupportedChainId,
} from "@wildcatfi/wildcat-sdk"

import { TargetChainId } from "@/config/network"

const PROXY_URL = process.env.NEXT_PUBLIC_INDEXER_PROXY_URL

export function getSubgraphClient(
  chainId: SupportedChainId
): ApolloClient<NormalizedCacheObject> {
  if (PROXY_URL) {
    return new ApolloClient({
      cache: new InMemoryCache(),
      link: new HttpLink({ uri: PROXY_URL }),
    })
  }
  return sdkGetSubgraphClient(chainId)
}

export const SubgraphClient = getSubgraphClient(TargetChainId)

export const lazyQueryOptions: LazyQueryHookOptions = {
  client: SubgraphClient,
  nextFetchPolicy: "network-only",
}
