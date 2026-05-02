"use client"

import { createContext, useContext, useMemo } from "react"

import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  NormalizedCacheObject,
} from "@apollo/client"
import { SupportedChainId } from "@wildcatfi/wildcat-sdk"
import { getSubgraphClient } from "@/config/subgraph"

import { NETWORKS } from "@/config/network"
import { useSelectedNetwork } from "@/hooks/useSelectedNetwork"

export type SubgraphClientType = ApolloClient<NormalizedCacheObject>

const TargetNetworkEnv = process.env.NEXT_PUBLIC_TARGET_NETWORK
const PROXY_URL = process.env.NEXT_PUBLIC_INDEXER_PROXY_URL

function createSubgraphClient(
  chainId: SupportedChainId
): SubgraphClientType {
  if (PROXY_URL) {
    return new ApolloClient({
      cache: new InMemoryCache(),
      link: new HttpLink({ uri: PROXY_URL }),
    })
  }
  return getSubgraphClient(chainId)
}

const isValidNetwork = (network: string): network is keyof typeof NETWORKS =>
  network in NETWORKS
const defaultNetwork =
  TargetNetworkEnv && isValidNetwork(TargetNetworkEnv)
    ? NETWORKS[TargetNetworkEnv]
    : NETWORKS.Mainnet

const SubgraphContext = createContext<SubgraphClientType>(
  createSubgraphClient(defaultNetwork.chainId as SupportedChainId),
)

export const SubgraphProvider = ({
  children,
}: {
  children: React.ReactNode
}) => {
  const { chainId } = useSelectedNetwork()
  const value = useMemo(() => {
    console.log(`Recreating subgraph client for chain ${chainId}`)
    return createSubgraphClient(chainId)
  }, [chainId])
  return (
    <SubgraphContext.Provider value={value} key={`subgraph-client-${chainId}`}>
      {children}
    </SubgraphContext.Provider>
  )
}

export const useSubgraphClient = () => useContext(SubgraphContext)
