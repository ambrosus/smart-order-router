import { FeeAmount } from '@airdao/astra-cl-sdk';
import { Protocol } from '@airdao/astra-router-sdk';
import { ChainId, Token, TradeType } from '@airdao/astra-sdk-core';
import _ from 'lodash';

import {
  ClassicPoolAccessor,
  ClassicSubgraphPool,
  CLPoolAccessor,
  CLSubgraphPool,
  IClassicPoolProvider,
  IClassicSubgraphProvider,
  ICLPoolProvider,
  ICLSubgraphProvider,
  ITokenListProvider,
  ITokenProvider,
} from '../../../providers';
import {
  log,
  metric,
  MetricLoggerUnit,
  parseFeeAmount,
  unparseFeeAmount,
  WRAPPED_NATIVE_CURRENCY,
} from '../../../util';
import { AlphaRouterConfig } from '../alpha-router';

export type PoolId = { id: string };
export type CandidatePoolsBySelectionCriteria = {
  protocol: Protocol;
  selections: CandidatePoolsSelections;
};

/// Utility type for allowing us to use `keyof CandidatePoolsSelections` to map
export type CandidatePoolsSelections = {
  topByBaseWithTokenIn: PoolId[];
  topByBaseWithTokenOut: PoolId[];
  topByDirectSwapPool: PoolId[];
  topByAmbQuoteTokenPool: PoolId[];
  topByTVL: PoolId[];
  topByTVLUsingTokenIn: PoolId[];
  topByTVLUsingTokenOut: PoolId[];
  topByTVLUsingTokenInSecondHops: PoolId[];
  topByTVLUsingTokenOutSecondHops: PoolId[];
};

export type CLGetCandidatePoolsParams = {
  tokenIn: Token;
  tokenOut: Token;
  routeType: TradeType;
  routingConfig: AlphaRouterConfig;
  subgraphProvider: ICLSubgraphProvider;
  tokenProvider: ITokenProvider;
  poolProvider: ICLPoolProvider;
  blockedTokenListProvider?: ITokenListProvider;
  chainId: ChainId;
};

export type ClassicGetCandidatePoolsParams = {
  tokenIn: Token;
  tokenOut: Token;
  routeType: TradeType;
  routingConfig: AlphaRouterConfig;
  subgraphProvider: IClassicSubgraphProvider;
  tokenProvider: ITokenProvider;
  poolProvider: IClassicPoolProvider;
  blockedTokenListProvider?: ITokenListProvider;
  chainId: ChainId;
};

export type MixedRouteGetCandidatePoolsParams = {
  clCandidatePools: CLCandidatePools;
  classicCandidatePools: ClassicCandidatePools;
  routingConfig: AlphaRouterConfig;
  tokenProvider: ITokenProvider;
  classicPoolProvider: IClassicPoolProvider;
  clPoolProvider: ICLPoolProvider;
  blockedTokenListProvider?: ITokenListProvider;
  chainId: ChainId;
};

const baseTokensByChain: { [chainId in ChainId]?: Token[] } = {
  [ChainId.MAINNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]!],
  [ChainId.TESTNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.TESTNET]!],
  [ChainId.DEVNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.DEVNET]!],
};

class SubcategorySelectionPools<SubgraphPool> {
  constructor(
    public pools: SubgraphPool[],
    public readonly poolsNeeded: number
  ) {}

  public hasEnoughPools(): boolean {
    return this.pools.length >= this.poolsNeeded;
  }
}

export type CLCandidatePools = {
  poolAccessor: CLPoolAccessor;
  candidatePools: CandidatePoolsBySelectionCriteria;
  subgraphPools: CLSubgraphPool[];
};

export async function getCLCandidatePools({
  tokenIn,
  tokenOut,
  routeType,
  routingConfig,
  subgraphProvider,
  tokenProvider,
  poolProvider,
  blockedTokenListProvider,
  chainId,
}: CLGetCandidatePoolsParams): Promise<CLCandidatePools> {
  const {
    blockNumber,
    clPoolSelection: {
      topN,
      topNDirectSwaps,
      topNTokenInOut,
      topNSecondHop,
      topNSecondHopForTokenAddress,
      tokensToAvoidOnSecondHops,
      topNWithEachBaseToken,
      topNWithBaseToken,
    },
  } = routingConfig;
  const tokenInAddress = tokenIn.address.toLowerCase();
  const tokenOutAddress = tokenOut.address.toLowerCase();

  const beforeSubgraphPools = Date.now();

  const allPools = await subgraphProvider.getPools(tokenIn, tokenOut, {
    blockNumber,
  });

  log.info(
    { samplePools: allPools.slice(0, 3) },
    'Got all pools from CL subgraph provider'
  );

  // Although this is less of an optimization than the Classic equivalent,
  // save some time copying objects by mutating the underlying pool directly.
  for (const pool of allPools) {
    pool.token0.id = pool.token0.id.toLowerCase();
    pool.token1.id = pool.token1.id.toLowerCase();
  }

  metric.putMetric(
    'CLSubgraphPoolsLoad',
    Date.now() - beforeSubgraphPools,
    MetricLoggerUnit.Milliseconds
  );

  const beforePoolsFiltered = Date.now();

  // Only consider pools where neither tokens are in the blocked token list.
  let filteredPools: CLSubgraphPool[] = allPools;
  if (blockedTokenListProvider) {
    filteredPools = [];
    for (const pool of allPools) {
      const token0InBlocklist =
        await blockedTokenListProvider.hasTokenByAddress(pool.token0.id);
      const token1InBlocklist =
        await blockedTokenListProvider.hasTokenByAddress(pool.token1.id);

      if (token0InBlocklist || token1InBlocklist) {
        continue;
      }

      filteredPools.push(pool);
    }
  }

  // Sort by tvlUSD in descending order
  const subgraphPoolsSorted = filteredPools.sort((a, b) => b.tvlUSD - a.tvlUSD);

  log.info(
    `After filtering blocked tokens went from ${allPools.length} to ${subgraphPoolsSorted.length}.`
  );

  const poolAddressesSoFar = new Set<string>();
  const addToAddressSet = (pools: CLSubgraphPool[]) => {
    _(pools)
      .map((pool) => pool.id)
      .forEach((poolAddress) => poolAddressesSoFar.add(poolAddress));
  };

  const baseTokens = baseTokensByChain[chainId] ?? [];

  const topByBaseWithTokenIn = _(baseTokens)
    .flatMap((token: Token) => {
      return _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
          const tokenAddress = token.address.toLowerCase();
          return (
            (subgraphPool.token0.id == tokenAddress &&
              subgraphPool.token1.id == tokenInAddress) ||
            (subgraphPool.token1.id == tokenAddress &&
              subgraphPool.token0.id == tokenInAddress)
          );
        })
        .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
        .slice(0, topNWithEachBaseToken)
        .value();
    })
    .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
    .slice(0, topNWithBaseToken)
    .value();

  const topByBaseWithTokenOut = _(baseTokens)
    .flatMap((token: Token) => {
      return _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
          const tokenAddress = token.address.toLowerCase();
          return (
            (subgraphPool.token0.id == tokenAddress &&
              subgraphPool.token1.id == tokenOutAddress) ||
            (subgraphPool.token1.id == tokenAddress &&
              subgraphPool.token0.id == tokenOutAddress)
          );
        })
        .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
        .slice(0, topNWithEachBaseToken)
        .value();
    })
    .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
    .slice(0, topNWithBaseToken)
    .value();

  let top2DirectSwapPool = _(subgraphPoolsSorted)
    .filter((subgraphPool) => {
      return (
        !poolAddressesSoFar.has(subgraphPool.id) &&
        ((subgraphPool.token0.id == tokenInAddress &&
          subgraphPool.token1.id == tokenOutAddress) ||
          (subgraphPool.token1.id == tokenInAddress &&
            subgraphPool.token0.id == tokenOutAddress))
      );
    })
    .slice(0, topNDirectSwaps)
    .value();

  if (top2DirectSwapPool.length == 0 && topNDirectSwaps > 0) {
    // If we requested direct swap pools but did not find any in the subgraph query.
    // Optimistically add them into the query regardless. Invalid pools ones will be dropped anyway
    // when we query the pool on-chain. Ensures that new pools for new pairs can be swapped on immediately.
    top2DirectSwapPool = _.map(
      [FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW, FeeAmount.LOWEST],
      (feeAmount) => {
        const { token0, token1, poolAddress } = poolProvider.getPoolAddress(
          tokenIn,
          tokenOut,
          feeAmount
        );
        return {
          id: poolAddress,
          feeTier: unparseFeeAmount(feeAmount),
          liquidity: '10000',
          token0: {
            id: token0.address,
          },
          token1: {
            id: token1.address,
          },
          tvlAMB: 10000,
          tvlUSD: 10000,
        };
      }
    );
  }

  addToAddressSet(top2DirectSwapPool);

  const wrappedNativeAddress =
    WRAPPED_NATIVE_CURRENCY[chainId]?.address.toLowerCase();

  // Main reason we need this is for gas estimates, only needed if token out is not native.
  // We don't check the seen address set because if we've already added pools for getting native quotes
  // theres no need to add more.
  let top2AmbQuoteTokenPool: CLSubgraphPool[] = [];
  if (
    WRAPPED_NATIVE_CURRENCY[chainId]?.symbol ==
      WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]?.symbol &&
    tokenOut.symbol != 'SAMB' &&
    tokenOut.symbol != 'SAMBT' &&
    tokenOut.symbol != 'AMB'
  ) {
    top2AmbQuoteTokenPool = _(subgraphPoolsSorted)
      .filter((subgraphPool) => {
        if (routeType == TradeType.EXACT_INPUT) {
          return (
            (subgraphPool.token0.id == wrappedNativeAddress &&
              subgraphPool.token1.id == tokenOutAddress) ||
            (subgraphPool.token1.id == wrappedNativeAddress &&
              subgraphPool.token0.id == tokenOutAddress)
          );
        } else {
          return (
            (subgraphPool.token0.id == wrappedNativeAddress &&
              subgraphPool.token1.id == tokenInAddress) ||
            (subgraphPool.token1.id == wrappedNativeAddress &&
              subgraphPool.token0.id == tokenInAddress)
          );
        }
      })
      .slice(0, 1)
      .value();
  }

  addToAddressSet(top2AmbQuoteTokenPool);

  const topByTVL = _(subgraphPoolsSorted)
    .filter((subgraphPool) => {
      return !poolAddressesSoFar.has(subgraphPool.id);
    })
    .slice(0, topN)
    .value();

  addToAddressSet(topByTVL);

  const topByTVLUsingTokenIn = _(subgraphPoolsSorted)
    .filter((subgraphPool) => {
      return (
        !poolAddressesSoFar.has(subgraphPool.id) &&
        (subgraphPool.token0.id == tokenInAddress ||
          subgraphPool.token1.id == tokenInAddress)
      );
    })
    .slice(0, topNTokenInOut)
    .value();

  addToAddressSet(topByTVLUsingTokenIn);

  const topByTVLUsingTokenOut = _(subgraphPoolsSorted)
    .filter((subgraphPool) => {
      return (
        !poolAddressesSoFar.has(subgraphPool.id) &&
        (subgraphPool.token0.id == tokenOutAddress ||
          subgraphPool.token1.id == tokenOutAddress)
      );
    })
    .slice(0, topNTokenInOut)
    .value();

  addToAddressSet(topByTVLUsingTokenOut);

  const topByTVLUsingTokenInSecondHops = _(topByTVLUsingTokenIn)
    .map((subgraphPool) => {
      return tokenInAddress == subgraphPool.token0.id
        ? subgraphPool.token1.id
        : subgraphPool.token0.id;
    })
    .flatMap((secondHopId: string) => {
      return _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
          return (
            !poolAddressesSoFar.has(subgraphPool.id) &&
            !tokensToAvoidOnSecondHops?.includes(secondHopId.toLowerCase()) &&
            (subgraphPool.token0.id == secondHopId ||
              subgraphPool.token1.id == secondHopId)
          );
        })
        .slice(
          0,
          topNSecondHopForTokenAddress?.get(secondHopId) ?? topNSecondHop
        )
        .value();
    })
    .uniqBy((pool) => pool.id)
    .value();

  addToAddressSet(topByTVLUsingTokenInSecondHops);

  const topByTVLUsingTokenOutSecondHops = _(topByTVLUsingTokenOut)
    .map((subgraphPool) => {
      return tokenOutAddress == subgraphPool.token0.id
        ? subgraphPool.token1.id
        : subgraphPool.token0.id;
    })
    .flatMap((secondHopId: string) => {
      return _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
          return (
            !poolAddressesSoFar.has(subgraphPool.id) &&
            !tokensToAvoidOnSecondHops?.includes(secondHopId.toLowerCase()) &&
            (subgraphPool.token0.id == secondHopId ||
              subgraphPool.token1.id == secondHopId)
          );
        })
        .slice(
          0,
          topNSecondHopForTokenAddress?.get(secondHopId) ?? topNSecondHop
        )
        .value();
    })
    .uniqBy((pool) => pool.id)
    .value();

  addToAddressSet(topByTVLUsingTokenOutSecondHops);

  const subgraphPools = _([
    ...topByBaseWithTokenIn,
    ...topByBaseWithTokenOut,
    ...top2DirectSwapPool,
    ...top2AmbQuoteTokenPool,
    ...topByTVL,
    ...topByTVLUsingTokenIn,
    ...topByTVLUsingTokenOut,
    ...topByTVLUsingTokenInSecondHops,
    ...topByTVLUsingTokenOutSecondHops,
  ])
    .compact()
    .uniqBy((pool) => pool.id)
    .value();

  const tokenAddresses = _(subgraphPools)
    .flatMap((subgraphPool) => [subgraphPool.token0.id, subgraphPool.token1.id])
    .compact()
    .uniq()
    .value();

  log.info(
    `Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} CL pools we are considering`
  );

  const tokenAccessor = await tokenProvider.getTokens(tokenAddresses, {
    blockNumber,
  });

  const printCLSubgraphPool = (s: CLSubgraphPool) =>
    `${tokenAccessor.getTokenByAddress(s.token0.id)?.symbol ?? s.token0.id}/${
      tokenAccessor.getTokenByAddress(s.token1.id)?.symbol ?? s.token1.id
    }/${s.feeTier}`;

  log.info(
    {
      topByBaseWithTokenIn: topByBaseWithTokenIn.map(printCLSubgraphPool),
      topByBaseWithTokenOut: topByBaseWithTokenOut.map(printCLSubgraphPool),
      topByTVL: topByTVL.map(printCLSubgraphPool),
      topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printCLSubgraphPool),
      topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(printCLSubgraphPool),
      topByTVLUsingTokenInSecondHops:
        topByTVLUsingTokenInSecondHops.map(printCLSubgraphPool),
      topByTVLUsingTokenOutSecondHops:
        topByTVLUsingTokenOutSecondHops.map(printCLSubgraphPool),
      top2DirectSwap: top2DirectSwapPool.map(printCLSubgraphPool),
      top2AmbQuotePool: top2AmbQuoteTokenPool.map(printCLSubgraphPool),
    },
    `CL Candidate Pools`
  );

  const tokenPairsRaw = _.map<
    CLSubgraphPool,
    [Token, Token, FeeAmount] | undefined
  >(subgraphPools, (subgraphPool) => {
    const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
    const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
    let fee: FeeAmount;
    try {
      fee = parseFeeAmount(subgraphPool.feeTier);
    } catch (err) {
      log.info(
        { subgraphPool },
        `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${subgraphPool.feeTier} because fee tier not supported`
      );
      return undefined;
    }

    if (!tokenA || !tokenB) {
      log.info(
        `Dropping candidate pool for ${subgraphPool.token0.id}/${
          subgraphPool.token1.id
        }/${fee} because ${
          tokenA ? subgraphPool.token1.id : subgraphPool.token0.id
        } not found by token provider`
      );
      return undefined;
    }

    return [tokenA, tokenB, fee];
  });

  const tokenPairs = _.compact(tokenPairsRaw);

  metric.putMetric(
    'CLPoolsFilterLoad',
    Date.now() - beforePoolsFiltered,
    MetricLoggerUnit.Milliseconds
  );

  const beforePoolsLoad = Date.now();

  const poolAccessor = await poolProvider.getPools(tokenPairs, {
    blockNumber,
  });

  metric.putMetric(
    'CLPoolsLoad',
    Date.now() - beforePoolsLoad,
    MetricLoggerUnit.Milliseconds
  );

  const poolsBySelection: CandidatePoolsBySelectionCriteria = {
    protocol: Protocol.CL,
    selections: {
      topByBaseWithTokenIn,
      topByBaseWithTokenOut,
      topByDirectSwapPool: top2DirectSwapPool,
      topByAmbQuoteTokenPool: top2AmbQuoteTokenPool,
      topByTVL,
      topByTVLUsingTokenIn,
      topByTVLUsingTokenOut,
      topByTVLUsingTokenInSecondHops,
      topByTVLUsingTokenOutSecondHops,
    },
  };

  return { poolAccessor, candidatePools: poolsBySelection, subgraphPools };
}

export type ClassicCandidatePools = {
  poolAccessor: ClassicPoolAccessor;
  candidatePools: CandidatePoolsBySelectionCriteria;
  subgraphPools: ClassicSubgraphPool[];
};

export async function getClassicCandidatePools({
  tokenIn,
  tokenOut,
  routeType,
  routingConfig,
  subgraphProvider,
  tokenProvider,
  poolProvider,
  blockedTokenListProvider,
  chainId,
}: ClassicGetCandidatePoolsParams): Promise<ClassicCandidatePools> {
  const {
    blockNumber,
    classicPoolSelection: {
      topN,
      topNDirectSwaps,
      topNTokenInOut,
      topNSecondHop,
      tokensToAvoidOnSecondHops,
      topNWithEachBaseToken,
      topNWithBaseToken,
    },
  } = routingConfig;
  const tokenInAddress = tokenIn.address.toLowerCase();
  const tokenOutAddress = tokenOut.address.toLowerCase();

  const beforeSubgraphPools = Date.now();

  const allPoolsRaw = await subgraphProvider.getPools(tokenIn, tokenOut, {
    blockNumber,
  });

  // With tens of thousands of Classic pools, operations that copy pools become costly.
  // Mutate the pool directly rather than creating a new pool / token to optimmize for speed.
  for (const pool of allPoolsRaw) {
    pool.token0.id = pool.token0.id.toLowerCase();
    pool.token1.id = pool.token1.id.toLowerCase();
  }

  metric.putMetric(
    'ClassicSubgraphPoolsLoad',
    Date.now() - beforeSubgraphPools,
    MetricLoggerUnit.Milliseconds
  );

  const beforePoolsFiltered = Date.now();

  // Sort by pool reserve in descending order.
  const subgraphPoolsSorted = allPoolsRaw.sort((a, b) => b.reserve - a.reserve);

  const poolAddressesSoFar = new Set<string>();

  // Always add the direct swap pool into the mix regardless of if it exists in the subgraph pool list.
  // Ensures that new pools can be swapped on immediately, and that if a pool was filtered out of the
  // subgraph query for some reason (e.g. trackedReserveAMB was 0), then we still consider it.
  let topByDirectSwapPool: ClassicSubgraphPool[] = [];
  if (topNDirectSwaps > 0) {
    const { token0, token1, poolAddress } = poolProvider.getPoolAddress(
      tokenIn,
      tokenOut
    );

    poolAddressesSoFar.add(poolAddress.toLowerCase());

    topByDirectSwapPool = [
      {
        id: poolAddress,
        token0: {
          id: token0.address,
        },
        token1: {
          id: token1.address,
        },
        supply: 10000, // Not used. Set to arbitrary number.
        reserve: 10000, // Not used. Set to arbitrary number.
        reserveUSD: 10000, // Not used. Set to arbitrary number.
      },
    ];
  }

  const sambAddress = WRAPPED_NATIVE_CURRENCY[chainId]!.address.toLowerCase();

  const topByBaseWithTokenInMap: Map<
    string,
    SubcategorySelectionPools<ClassicSubgraphPool>
  > = new Map();
  const topByBaseWithTokenOutMap: Map<
    string,
    SubcategorySelectionPools<ClassicSubgraphPool>
  > = new Map();

  const baseTokens = baseTokensByChain[chainId] ?? [];
  const baseTokensAddresses: Set<string> = new Set();

  baseTokens.forEach((token) => {
    const baseTokenAddr = token.address.toLowerCase();

    baseTokensAddresses.add(baseTokenAddr);
    topByBaseWithTokenInMap.set(
      baseTokenAddr,
      new SubcategorySelectionPools<ClassicSubgraphPool>(
        [],
        topNWithEachBaseToken
      )
    );
    topByBaseWithTokenOutMap.set(
      baseTokenAddr,
      new SubcategorySelectionPools<ClassicSubgraphPool>(
        [],
        topNWithEachBaseToken
      )
    );
  });

  let topByBaseWithTokenInPoolsFound = 0;
  let topByBaseWithTokenOutPoolsFound = 0;

  // Main reason we need this is for gas estimates
  // There can ever only be 1 Token/AMB pool, so we will only look for 1
  let topNAmbQuoteToken = 1;
  // but, we only need it if token out is not AMB.
  if (
    tokenOut.symbol == 'SAMB' ||
    tokenOut.symbol == 'SAMB9' ||
    tokenOut.symbol == 'AMB'
  ) {
    // if it's amb we change the topN to 0, so we can break early from the loop.
    topNAmbQuoteToken = 0;
  }

  const topByAmbQuoteTokenPool: ClassicSubgraphPool[] = [];
  const topByTVLUsingTokenIn: ClassicSubgraphPool[] = [];
  const topByTVLUsingTokenOut: ClassicSubgraphPool[] = [];
  const topByTVL: ClassicSubgraphPool[] = [];

  // Used to track how many iterations we do in the first loop
  let loopsInFirstIteration = 0;

  // Filtering step for up to first hop
  // The pools are pre-sorted, so we can just iterate through them and fill our heuristics.
  for (const subgraphPool of subgraphPoolsSorted) {
    loopsInFirstIteration += 1;
    // Check if we have satisfied all the heuristics, if so, we can stop.
    if (
      topByBaseWithTokenInPoolsFound >= topNWithBaseToken &&
      topByBaseWithTokenOutPoolsFound >= topNWithBaseToken &&
      topByAmbQuoteTokenPool.length >= topNAmbQuoteToken &&
      topByTVL.length >= topN &&
      topByTVLUsingTokenIn.length >= topNTokenInOut &&
      topByTVLUsingTokenOut.length >= topNTokenInOut
    ) {
      // We have satisfied all the heuristics, so we can stop.
      break;
    }

    if (poolAddressesSoFar.has(subgraphPool.id)) {
      // We've already added this pool, so skip it.
      continue;
    }

    // Only consider pools where neither tokens are in the blocked token list.
    if (blockedTokenListProvider) {
      const [token0InBlocklist, token1InBlocklist] = await Promise.all([
        blockedTokenListProvider.hasTokenByAddress(subgraphPool.token0.id),
        blockedTokenListProvider.hasTokenByAddress(subgraphPool.token1.id),
      ]);

      if (token0InBlocklist || token1InBlocklist) {
        continue;
      }
    }

    const tokenInToken0TopByBase = topByBaseWithTokenInMap.get(
      subgraphPool.token0.id
    );
    if (
      topByBaseWithTokenInPoolsFound < topNWithBaseToken &&
      tokenInToken0TopByBase &&
      subgraphPool.token0.id != tokenOutAddress &&
      subgraphPool.token1.id == tokenInAddress
    ) {
      topByBaseWithTokenInPoolsFound += 1;
      poolAddressesSoFar.add(subgraphPool.id);
      if (topByTVLUsingTokenIn.length < topNTokenInOut) {
        topByTVLUsingTokenIn.push(subgraphPool);
      }
      if (
        routeType === TradeType.EXACT_OUTPUT &&
        subgraphPool.token0.id == sambAddress
      ) {
        topByAmbQuoteTokenPool.push(subgraphPool);
      }
      tokenInToken0TopByBase.pools.push(subgraphPool);
      continue;
    }

    const tokenInToken1TopByBase = topByBaseWithTokenInMap.get(
      subgraphPool.token1.id
    );
    if (
      topByBaseWithTokenInPoolsFound < topNWithBaseToken &&
      tokenInToken1TopByBase &&
      subgraphPool.token0.id == tokenInAddress &&
      subgraphPool.token1.id != tokenOutAddress
    ) {
      topByBaseWithTokenInPoolsFound += 1;
      poolAddressesSoFar.add(subgraphPool.id);
      if (topByTVLUsingTokenIn.length < topNTokenInOut) {
        topByTVLUsingTokenIn.push(subgraphPool);
      }
      if (
        routeType === TradeType.EXACT_OUTPUT &&
        subgraphPool.token1.id == sambAddress
      ) {
        topByAmbQuoteTokenPool.push(subgraphPool);
      }
      tokenInToken1TopByBase.pools.push(subgraphPool);
      continue;
    }

    const tokenOutToken0TopByBase = topByBaseWithTokenOutMap.get(
      subgraphPool.token0.id
    );
    if (
      topByBaseWithTokenOutPoolsFound < topNWithBaseToken &&
      tokenOutToken0TopByBase &&
      subgraphPool.token0.id != tokenInAddress &&
      subgraphPool.token1.id == tokenOutAddress
    ) {
      topByBaseWithTokenOutPoolsFound += 1;
      poolAddressesSoFar.add(subgraphPool.id);
      if (topByTVLUsingTokenOut.length < topNTokenInOut) {
        topByTVLUsingTokenOut.push(subgraphPool);
      }
      if (
        routeType === TradeType.EXACT_INPUT &&
        subgraphPool.token0.id == sambAddress
      ) {
        topByAmbQuoteTokenPool.push(subgraphPool);
      }
      tokenOutToken0TopByBase.pools.push(subgraphPool);
      continue;
    }

    const tokenOutToken1TopByBase = topByBaseWithTokenOutMap.get(
      subgraphPool.token1.id
    );
    if (
      topByBaseWithTokenOutPoolsFound < topNWithBaseToken &&
      tokenOutToken1TopByBase &&
      subgraphPool.token0.id == tokenOutAddress &&
      subgraphPool.token1.id != tokenInAddress
    ) {
      topByBaseWithTokenOutPoolsFound += 1;
      poolAddressesSoFar.add(subgraphPool.id);
      if (topByTVLUsingTokenOut.length < topNTokenInOut) {
        topByTVLUsingTokenOut.push(subgraphPool);
      }
      if (
        routeType === TradeType.EXACT_INPUT &&
        subgraphPool.token1.id == sambAddress
      ) {
        topByAmbQuoteTokenPool.push(subgraphPool);
      }
      tokenOutToken1TopByBase.pools.push(subgraphPool);
      continue;
    }

    // Note: we do not need to check other native currencies for the Classic Protocol
    if (
      topByAmbQuoteTokenPool.length < topNAmbQuoteToken &&
      ((routeType === TradeType.EXACT_INPUT &&
        ((subgraphPool.token0.id == sambAddress &&
          subgraphPool.token1.id == tokenOutAddress) ||
          (subgraphPool.token1.id == sambAddress &&
            subgraphPool.token0.id == tokenOutAddress))) ||
        (routeType === TradeType.EXACT_OUTPUT &&
          ((subgraphPool.token0.id == sambAddress &&
            subgraphPool.token1.id == tokenInAddress) ||
            (subgraphPool.token1.id == sambAddress &&
              subgraphPool.token0.id == tokenInAddress))))
    ) {
      poolAddressesSoFar.add(subgraphPool.id);
      topByAmbQuoteTokenPool.push(subgraphPool);
      continue;
    }

    if (topByTVL.length < topN) {
      poolAddressesSoFar.add(subgraphPool.id);
      topByTVL.push(subgraphPool);
      continue;
    }

    if (
      topByTVLUsingTokenIn.length < topNTokenInOut &&
      (subgraphPool.token0.id == tokenInAddress ||
        subgraphPool.token1.id == tokenInAddress)
    ) {
      poolAddressesSoFar.add(subgraphPool.id);
      topByTVLUsingTokenIn.push(subgraphPool);
      continue;
    }

    if (
      topByTVLUsingTokenOut.length < topNTokenInOut &&
      (subgraphPool.token0.id == tokenOutAddress ||
        subgraphPool.token1.id == tokenOutAddress)
    ) {
      poolAddressesSoFar.add(subgraphPool.id);
      topByTVLUsingTokenOut.push(subgraphPool);
    }
  }

  metric.putMetric(
    'ClassicSubgraphLoopsInFirstIteration',
    loopsInFirstIteration,
    MetricLoggerUnit.Count
  );

  const topByBaseWithTokenIn: ClassicSubgraphPool[] = [];
  for (const topByBaseWithTokenInSelection of topByBaseWithTokenInMap.values()) {
    topByBaseWithTokenIn.push(...topByBaseWithTokenInSelection.pools);
  }

  const topByBaseWithTokenOut: ClassicSubgraphPool[] = [];
  for (const topByBaseWithTokenOutSelection of topByBaseWithTokenOutMap.values()) {
    topByBaseWithTokenOut.push(...topByBaseWithTokenOutSelection.pools);
  }

  // Filtering step for second hops
  const topByTVLUsingTokenInSecondHopsMap: Map<
    string,
    SubcategorySelectionPools<ClassicSubgraphPool>
  > = new Map();
  const topByTVLUsingTokenOutSecondHopsMap: Map<
    string,
    SubcategorySelectionPools<ClassicSubgraphPool>
  > = new Map();
  const tokenInSecondHopAddresses = topByTVLUsingTokenIn
    .filter((pool) => {
      // filtering second hops
      if (tokenInAddress === pool.token0.id) {
        return !tokensToAvoidOnSecondHops?.includes(
          pool.token1.id.toLowerCase()
        );
      } else {
        return !tokensToAvoidOnSecondHops?.includes(
          pool.token0.id.toLowerCase()
        );
      }
    })
    .map((pool) =>
      tokenInAddress === pool.token0.id ? pool.token1.id : pool.token0.id
    );
  const tokenOutSecondHopAddresses = topByTVLUsingTokenOut
    .filter((pool) => {
      // filtering second hops
      if (tokenOutAddress === pool.token0.id) {
        return !tokensToAvoidOnSecondHops?.includes(
          pool.token1.id.toLowerCase()
        );
      } else {
        return !tokensToAvoidOnSecondHops?.includes(
          pool.token0.id.toLowerCase()
        );
      }
    })
    .map((pool) =>
      tokenOutAddress === pool.token0.id ? pool.token1.id : pool.token0.id
    );

  for (const secondHopId of tokenInSecondHopAddresses) {
    topByTVLUsingTokenInSecondHopsMap.set(
      secondHopId,
      new SubcategorySelectionPools<ClassicSubgraphPool>([], topNSecondHop)
    );
  }
  for (const secondHopId of tokenOutSecondHopAddresses) {
    topByTVLUsingTokenOutSecondHopsMap.set(
      secondHopId,
      new SubcategorySelectionPools<ClassicSubgraphPool>([], topNSecondHop)
    );
  }

  // Used to track how many iterations we do in the second loop
  let loopsInSecondIteration = 0;

  if (
    tokenInSecondHopAddresses.length > 0 ||
    tokenOutSecondHopAddresses.length > 0
  ) {
    for (const subgraphPool of subgraphPoolsSorted) {
      loopsInSecondIteration += 1;

      let allTokenInSecondHopsHaveTheirTopN = true;
      for (const secondHopPools of topByTVLUsingTokenInSecondHopsMap.values()) {
        if (!secondHopPools.hasEnoughPools()) {
          allTokenInSecondHopsHaveTheirTopN = false;
          break;
        }
      }

      let allTokenOutSecondHopsHaveTheirTopN = true;
      for (const secondHopPools of topByTVLUsingTokenOutSecondHopsMap.values()) {
        if (!secondHopPools.hasEnoughPools()) {
          allTokenOutSecondHopsHaveTheirTopN = false;
          break;
        }
      }

      if (
        allTokenInSecondHopsHaveTheirTopN &&
        allTokenOutSecondHopsHaveTheirTopN
      ) {
        // We have satisfied all the heuristics, so we can stop.
        break;
      }

      if (poolAddressesSoFar.has(subgraphPool.id)) {
        continue;
      }

      // Only consider pools where neither tokens are in the blocked token list.
      if (blockedTokenListProvider) {
        const [token0InBlocklist, token1InBlocklist] = await Promise.all([
          blockedTokenListProvider.hasTokenByAddress(subgraphPool.token0.id),
          blockedTokenListProvider.hasTokenByAddress(subgraphPool.token1.id),
        ]);

        if (token0InBlocklist || token1InBlocklist) {
          continue;
        }
      }

      const tokenInToken0SecondHop = topByTVLUsingTokenInSecondHopsMap.get(
        subgraphPool.token0.id
      );

      if (tokenInToken0SecondHop && !tokenInToken0SecondHop.hasEnoughPools()) {
        poolAddressesSoFar.add(subgraphPool.id);
        tokenInToken0SecondHop.pools.push(subgraphPool);
        continue;
      }

      const tokenInToken1SecondHop = topByTVLUsingTokenInSecondHopsMap.get(
        subgraphPool.token1.id
      );

      if (tokenInToken1SecondHop && !tokenInToken1SecondHop.hasEnoughPools()) {
        poolAddressesSoFar.add(subgraphPool.id);
        tokenInToken1SecondHop.pools.push(subgraphPool);
        continue;
      }

      const tokenOutToken0SecondHop = topByTVLUsingTokenOutSecondHopsMap.get(
        subgraphPool.token0.id
      );

      if (
        tokenOutToken0SecondHop &&
        !tokenOutToken0SecondHop.hasEnoughPools()
      ) {
        poolAddressesSoFar.add(subgraphPool.id);
        tokenOutToken0SecondHop.pools.push(subgraphPool);
        continue;
      }

      const tokenOutToken1SecondHop = topByTVLUsingTokenOutSecondHopsMap.get(
        subgraphPool.token1.id
      );

      if (
        tokenOutToken1SecondHop &&
        !tokenOutToken1SecondHop.hasEnoughPools()
      ) {
        poolAddressesSoFar.add(subgraphPool.id);
        tokenOutToken1SecondHop.pools.push(subgraphPool);
      }
    }
  }

  metric.putMetric(
    'ClassicSubgraphLoopsInSecondIteration',
    loopsInSecondIteration,
    MetricLoggerUnit.Count
  );

  const topByTVLUsingTokenInSecondHops: ClassicSubgraphPool[] = [];
  for (const secondHopPools of topByTVLUsingTokenInSecondHopsMap.values()) {
    topByTVLUsingTokenInSecondHops.push(...secondHopPools.pools);
  }

  const topByTVLUsingTokenOutSecondHops: ClassicSubgraphPool[] = [];
  for (const secondHopPools of topByTVLUsingTokenOutSecondHopsMap.values()) {
    topByTVLUsingTokenOutSecondHops.push(...secondHopPools.pools);
  }

  const subgraphPools = _([
    ...topByBaseWithTokenIn,
    ...topByBaseWithTokenOut,
    ...topByDirectSwapPool,
    ...topByAmbQuoteTokenPool,
    ...topByTVL,
    ...topByTVLUsingTokenIn,
    ...topByTVLUsingTokenOut,
    ...topByTVLUsingTokenInSecondHops,
    ...topByTVLUsingTokenOutSecondHops,
  ])
    .uniqBy((pool) => pool.id)
    .value();

  const tokenAddressesSet: Set<string> = new Set();
  for (const pool of subgraphPools) {
    tokenAddressesSet.add(pool.token0.id);
    tokenAddressesSet.add(pool.token1.id);
  }
  const tokenAddresses = Array.from(tokenAddressesSet);

  log.info(
    `Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} Classic pools we are considering`
  );

  const tokenAccessor = await tokenProvider.getTokens(tokenAddresses, {
    blockNumber,
  });

  const printClassicSubgraphPool = (s: ClassicSubgraphPool) =>
    `${tokenAccessor.getTokenByAddress(s.token0.id)?.symbol ?? s.token0.id}/${
      tokenAccessor.getTokenByAddress(s.token1.id)?.symbol ?? s.token1.id
    }`;

  log.info(
    {
      topByBaseWithTokenIn: topByBaseWithTokenIn.map(printClassicSubgraphPool),
      topByBaseWithTokenOut: topByBaseWithTokenOut.map(
        printClassicSubgraphPool
      ),
      topByTVL: topByTVL.map(printClassicSubgraphPool),
      topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printClassicSubgraphPool),
      topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(
        printClassicSubgraphPool
      ),
      topByTVLUsingTokenInSecondHops: topByTVLUsingTokenInSecondHops.map(
        printClassicSubgraphPool
      ),
      topByTVLUsingTokenOutSecondHops: topByTVLUsingTokenOutSecondHops.map(
        printClassicSubgraphPool
      ),
      top2DirectSwap: topByDirectSwapPool.map(printClassicSubgraphPool),
      top2AmbQuotePool: topByAmbQuoteTokenPool.map(printClassicSubgraphPool),
    },
    `Classic Candidate pools`
  );

  const tokenPairsRaw = _.map<ClassicSubgraphPool, [Token, Token] | undefined>(
    subgraphPools,
    (subgraphPool) => {
      const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
      const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);

      if (!tokenA || !tokenB) {
        log.info(
          `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}`
        );
        return undefined;
      }

      return [tokenA, tokenB];
    }
  );

  const tokenPairs = _.compact(tokenPairsRaw);

  metric.putMetric(
    'ClassicPoolsFilterLoad',
    Date.now() - beforePoolsFiltered,
    MetricLoggerUnit.Milliseconds
  );

  const beforePoolsLoad = Date.now();

  // this should be the only place to enable fee-on-transfer fee fetching,
  // because this places loads pools (pairs of tokens with fot taxes) from the subgraph
  const poolAccessor = await poolProvider.getPools(tokenPairs, routingConfig);

  metric.putMetric(
    'ClassicPoolsLoad',
    Date.now() - beforePoolsLoad,
    MetricLoggerUnit.Milliseconds
  );

  const poolsBySelection: CandidatePoolsBySelectionCriteria = {
    protocol: Protocol.Classic,
    selections: {
      topByBaseWithTokenIn,
      topByBaseWithTokenOut,
      topByDirectSwapPool,
      topByAmbQuoteTokenPool: topByAmbQuoteTokenPool,
      topByTVL,
      topByTVLUsingTokenIn,
      topByTVLUsingTokenOut,
      topByTVLUsingTokenInSecondHops,
      topByTVLUsingTokenOutSecondHops,
    },
  };

  return { poolAccessor, candidatePools: poolsBySelection, subgraphPools };
}

export type MixedCandidatePools = {
  ClassicPoolAccessor: ClassicPoolAccessor;
  CLPoolAccessor: CLPoolAccessor;
  candidatePools: CandidatePoolsBySelectionCriteria;
  subgraphPools: (ClassicSubgraphPool | CLSubgraphPool)[];
};

export async function getMixedRouteCandidatePools({
  clCandidatePools,
  classicCandidatePools,
  routingConfig,
  tokenProvider,
  clPoolProvider,
  classicPoolProvider,
}: MixedRouteGetCandidatePoolsParams): Promise<MixedCandidatePools> {
  const beforeSubgraphPools = Date.now();
  const [
    { subgraphPools: CLSubgraphPools, candidatePools: CLCandidatePools },
    {
      subgraphPools: ClassicSubgraphPools,
      candidatePools: ClassicCandidatePools,
    },
  ] = [clCandidatePools, classicCandidatePools];

  metric.putMetric(
    'MixedSubgraphPoolsLoad',
    Date.now() - beforeSubgraphPools,
    MetricLoggerUnit.Milliseconds
  );
  const beforePoolsFiltered = Date.now();

  /**
   * Main heuristic for pruning mixedRoutes:
   * - we pick Classic pools with higher liq than respective CL pools, or if the CL pool doesn't exist
   *
   * This way we can reduce calls to our provider since it's possible to generate a lot of mixed routes
   */
  /// We only really care about pools involving the tokenIn or tokenOut explictly,
  /// since there's no way a long tail token in Classic would be routed through as an intermediary
  const ClassicTopByTVLPoolIds = new Set(
    [
      ...ClassicCandidatePools.selections.topByTVLUsingTokenIn,
      ...ClassicCandidatePools.selections.topByBaseWithTokenIn,
      /// tokenOut:
      ...ClassicCandidatePools.selections.topByTVLUsingTokenOut,
      ...ClassicCandidatePools.selections.topByBaseWithTokenOut,
      /// Direct swap:
      ...ClassicCandidatePools.selections.topByDirectSwapPool,
    ].map((poolId) => poolId.id)
  );

  const ClassicTopByTVLSortedPools = _(ClassicSubgraphPools)
    .filter((pool) => ClassicTopByTVLPoolIds.has(pool.id))
    .sortBy((pool) => -pool.reserveUSD)
    .value();

  /// we consider all returned CL pools for this heuristic to "fill in the gaps"
  const CLSortedPools = _(CLSubgraphPools)
    .sortBy((pool) => -pool.tvlUSD)
    .value();

  /// Finding pools with greater reserveUSD on Classic than tvlUSD on CL, or if there is no CL liquidity
  const buildClassicPools: ClassicSubgraphPool[] = [];
  ClassicTopByTVLSortedPools.forEach((ClassicSubgraphPool) => {
    const CLSubgraphPool = CLSortedPools.find(
      (pool) =>
        (pool.token0.id == ClassicSubgraphPool.token0.id &&
          pool.token1.id == ClassicSubgraphPool.token1.id) ||
        (pool.token0.id == ClassicSubgraphPool.token1.id &&
          pool.token1.id == ClassicSubgraphPool.token0.id)
    );

    if (CLSubgraphPool) {
      if (ClassicSubgraphPool.reserveUSD > CLSubgraphPool.tvlUSD) {
        log.info(
          {
            token0: ClassicSubgraphPool.token0.id,
            token1: ClassicSubgraphPool.token1.id,
            classicReserveUSD: ClassicSubgraphPool.reserveUSD,
            clTvlUSD: CLSubgraphPool.tvlUSD,
          },
          `MixedRoute heuristic, found a Classic pool with higher liquidity than its CL counterpart`
        );
        buildClassicPools.push(ClassicSubgraphPool);
      }
    } else {
      log.info(
        {
          token0: ClassicSubgraphPool.token0.id,
          token1: ClassicSubgraphPool.token1.id,
          ClassicReserveUSD: ClassicSubgraphPool.reserveUSD,
        },
        `MixedRoute heuristic, found a Classic pool with no CL counterpart`
      );
      buildClassicPools.push(ClassicSubgraphPool);
    }
  });

  log.info(
    buildClassicPools.length,
    `Number of CL candidate pools that fit first heuristic`
  );

  const subgraphPools = [...buildClassicPools, ...CLSortedPools];

  const tokenAddresses = _(subgraphPools)
    .flatMap((subgraphPool) => [subgraphPool.token0.id, subgraphPool.token1.id])
    .compact()
    .uniq()
    .value();

  log.info(
    `Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} pools we are considering`
  );

  const tokenAccessor = await tokenProvider.getTokens(
    tokenAddresses,
    routingConfig
  );

  const CLTokenPairsRaw = _.map<
    CLSubgraphPool,
    [Token, Token, FeeAmount] | undefined
  >(CLSortedPools, (subgraphPool) => {
    const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
    const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
    let fee: FeeAmount;
    try {
      fee = parseFeeAmount(subgraphPool.feeTier);
    } catch (err) {
      log.info(
        { subgraphPool },
        `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${subgraphPool.feeTier} because fee tier not supported`
      );
      return undefined;
    }

    if (!tokenA || !tokenB) {
      log.info(
        `Dropping candidate pool for ${subgraphPool.token0.id}/${
          subgraphPool.token1.id
        }/${fee} because ${
          tokenA ? subgraphPool.token1.id : subgraphPool.token0.id
        } not found by token provider`
      );
      return undefined;
    }

    return [tokenA, tokenB, fee];
  });

  const CLTokenPairs = _.compact(CLTokenPairsRaw);

  const ClassicTokenPairsRaw = _.map<
    ClassicSubgraphPool,
    [Token, Token] | undefined
  >(buildClassicPools, (subgraphPool) => {
    const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
    const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);

    if (!tokenA || !tokenB) {
      log.info(
        `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}`
      );
      return undefined;
    }

    return [tokenA, tokenB];
  });

  const ClassicTokenPairs = _.compact(ClassicTokenPairsRaw);

  metric.putMetric(
    'MixedPoolsFilterLoad',
    Date.now() - beforePoolsFiltered,
    MetricLoggerUnit.Milliseconds
  );

  const beforePoolsLoad = Date.now();

  const [ClassicPoolAccessor, CLPoolAccessor] = await Promise.all([
    classicPoolProvider.getPools(ClassicTokenPairs, routingConfig),
    clPoolProvider.getPools(CLTokenPairs, routingConfig),
  ]);

  metric.putMetric(
    'MixedPoolsLoad',
    Date.now() - beforePoolsLoad,
    MetricLoggerUnit.Milliseconds
  );

  /// @dev a bit tricky here since the original ClassicCandidateSelections object included pools that we may have dropped
  /// as part of the heuristic. We need to reconstruct a new object with the CL pools too.
  const buildPoolsBySelection = (key: keyof CandidatePoolsSelections) => {
    return [
      ...buildClassicPools.filter((pool) =>
        ClassicCandidatePools.selections[key].map((p) => p.id).includes(pool.id)
      ),
      ...CLCandidatePools.selections[key],
    ];
  };

  const poolsBySelection: CandidatePoolsBySelectionCriteria = {
    protocol: Protocol.MIXED,
    selections: {
      topByBaseWithTokenIn: buildPoolsBySelection('topByBaseWithTokenIn'),
      topByBaseWithTokenOut: buildPoolsBySelection('topByBaseWithTokenOut'),
      topByDirectSwapPool: buildPoolsBySelection('topByDirectSwapPool'),
      topByAmbQuoteTokenPool: buildPoolsBySelection('topByAmbQuoteTokenPool'),
      topByTVL: buildPoolsBySelection('topByTVL'),
      topByTVLUsingTokenIn: buildPoolsBySelection('topByTVLUsingTokenIn'),
      topByTVLUsingTokenOut: buildPoolsBySelection('topByTVLUsingTokenOut'),
      topByTVLUsingTokenInSecondHops: buildPoolsBySelection(
        'topByTVLUsingTokenInSecondHops'
      ),
      topByTVLUsingTokenOutSecondHops: buildPoolsBySelection(
        'topByTVLUsingTokenOutSecondHops'
      ),
    },
  };

  return {
    ClassicPoolAccessor: ClassicPoolAccessor,
    CLPoolAccessor: CLPoolAccessor,
    candidatePools: poolsBySelection,
    subgraphPools,
  };
}
