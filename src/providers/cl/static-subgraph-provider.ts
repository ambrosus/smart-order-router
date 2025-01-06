/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { FeeAmount, Pool } from '@airdao/astra-cl-sdk';
import { ChainId, Token } from '@airdao/astra-sdk-core';
import JSBI from 'jsbi';
import _ from 'lodash';

import { log, unparseFeeAmount, WRAPPED_NATIVE_CURRENCY } from '../../util';
import { ProviderConfig } from '../provider';

import { ICLPoolProvider } from './pool-provider';
import { CLSubgraphPool, ICLSubgraphProvider } from './subgraph-provider';

type ChainTokenList = {
  readonly [chainId in ChainId]: Token[];
};

const BASES_TO_CHECK_TRADES_AGAINST: ChainTokenList = {
  [ChainId.MAINNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]!],
  [ChainId.TESTNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.TESTNET]!],
  [ChainId.DEVNET]: [WRAPPED_NATIVE_CURRENCY[ChainId.DEVNET]!],
};

/**
 * Provider that uses a hardcoded list of CL pools to generate a list of subgraph pools.
 *
 * Since the pools are hardcoded and the data does not come from the Subgraph, the TVL values
 * are dummys and should not be depended on.
 *
 * Useful for instances where other data sources are unavailable. E.g. Subgraph not available.
 *
 * @export
 * @class StaticCLSubgraphProvider
 */
export class StaticCLSubgraphProvider implements ICLSubgraphProvider {
  constructor(
    private chainId: ChainId,
    private poolProvider: ICLPoolProvider
  ) {}

  public async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<CLSubgraphPool[]> {
    log.info('In static subgraph provider for CL');
    const bases = BASES_TO_CHECK_TRADES_AGAINST[this.chainId];

    const basePairs: [Token, Token][] = _.flatMap(
      bases,
      (base): [Token, Token][] => bases.map((otherBase) => [base, otherBase])
    );

    if (tokenIn && tokenOut) {
      basePairs.push(
        [tokenIn, tokenOut],
        ...bases.map((base): [Token, Token] => [tokenIn, base]),
        ...bases.map((base): [Token, Token] => [tokenOut, base])
      );
    }

    const pairs: [Token, Token, FeeAmount][] = _(basePairs)
      .filter((tokens): tokens is [Token, Token] =>
        Boolean(tokens[0] && tokens[1])
      )
      .filter(
        ([tokenA, tokenB]) =>
          tokenA.address !== tokenB.address && !tokenA.equals(tokenB)
      )
      .flatMap<[Token, Token, FeeAmount]>(([tokenA, tokenB]) => {
        return [
          [tokenA, tokenB, FeeAmount.LOWEST],
          [tokenA, tokenB, FeeAmount.LOW],
          [tokenA, tokenB, FeeAmount.MEDIUM],
          [tokenA, tokenB, FeeAmount.HIGH],
        ];
      })
      .value();

    log.info(
      `CL Static subgraph provider about to get ${pairs.length} pools on-chain`
    );
    const poolAccessor = await this.poolProvider.getPools(
      pairs,
      providerConfig
    );
    const pools = poolAccessor.getAllPools();

    const poolAddressSet = new Set<string>();
    const subgraphPools: CLSubgraphPool[] = _(pools)
      .map((pool) => {
        const { token0, token1, fee, liquidity } = pool;

        const poolAddress = Pool.getAddress(pool.token0, pool.token1, pool.fee);

        if (poolAddressSet.has(poolAddress)) {
          return undefined;
        }
        poolAddressSet.add(poolAddress);

        const liquidityNumber = JSBI.toNumber(liquidity);

        return {
          id: poolAddress,
          feeTier: unparseFeeAmount(fee),
          liquidity: liquidity.toString(),
          token0: {
            id: token0.address,
          },
          token1: {
            id: token1.address,
          },
          // As a very rough proxy we just use liquidity for TVL.
          tvlAMB: liquidityNumber,
          tvlUSD: liquidityNumber,
        };
      })
      .compact()
      .value();

    return subgraphPools;
  }
}
