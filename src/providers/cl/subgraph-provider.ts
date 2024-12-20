import { ChainId, Token } from '@airdao/astra-sdk-core';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import { gql, GraphQLClient } from 'graphql-request';
import _ from 'lodash';

import { log } from '../../util';
import { ClassicSubgraphPool } from '../classic/subgraph-provider';
import { ProviderConfig } from '../provider';

export interface CLSubgraphPool {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    id: string;
  };
  token1: {
    id: string;
  };
  tvlAMB: number;
  tvlUSD: number;
}

type RawCLSubgraphPool = {
  id: string;
  feeTier: string;
  liquidity: string;
  token0: {
    symbol: string;
    id: string;
  };
  token1: {
    symbol: string;
    id: string;
  };
  totalValueLockedUSD: string;
  totalValueLockedAMB: string;
};

export const printCLSubgraphPool = (s: CLSubgraphPool) =>
  `${s.token0.id}/${s.token1.id}/${s.feeTier}`;

export const printClassicSubgraphPool = (s: ClassicSubgraphPool) =>
  `${s.token0.id}/${s.token1.id}`;

const SUBGRAPH_URL_BY_CHAIN: { [chainId in ChainId]?: string } = {
  [ChainId.MAINNET]:
    'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
  [ChainId.OPTIMISM]:
    'https://api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis',
  [ChainId.ARBITRUM_ONE]:
    'https://api.thegraph.com/subgraphs/name/ianlapham/arbitrum-minimal',
  [ChainId.POLYGON]:
    'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-polygon',
  [ChainId.CELO]:
    'https://api.thegraph.com/subgraphs/name/jesse-sawa/uniswap-celo',
  [ChainId.GOERLI]:
    'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-gorli',
  [ChainId.BNB]:
    'https://api.thegraph.com/subgraphs/name/ilyamk/uniswap-v3---bnb-chain',
  [ChainId.AVALANCHE]:
    'https://api.thegraph.com/subgraphs/name/lynnshaoyu/uniswap-v3-avax',
  [ChainId.BASE]:
    'https://api.studio.thegraph.com/query/48211/uniswap-v3-base/version/latest',
  [ChainId.AIRDAO_TEST]:
    'http://65.21.250.87:8000/subgraphs/name/airdao/uniswap-v3/graphql',
};

const PAGE_SIZE = 1000; // 1k is max possible query size from subgraph.

/**
 * Provider for getting CL pools from the Subgraph
 *
 * @export
 * @interface ICLSubgraphProvider
 */
export interface ICLSubgraphProvider {
  getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<CLSubgraphPool[]>;
}

export class CLSubgraphProvider implements ICLSubgraphProvider {
  private client: GraphQLClient;

  constructor(
    private chainId: ChainId,
    private retries = 2,
    private timeout = 30000,
    private rollback = true
  ) {
    const subgraphUrl = SUBGRAPH_URL_BY_CHAIN[this.chainId];
    if (!subgraphUrl) {
      throw new Error(`No subgraph url for chain id: ${this.chainId}`);
    }
    this.client = new GraphQLClient(subgraphUrl);
  }

  public async getPools(
    _tokenIn?: Token,
    _tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<CLSubgraphPool[]> {
    let blockNumber = providerConfig?.blockNumber
      ? await providerConfig.blockNumber
      : undefined;

    const query = gql`
      query getPools($pageSize: Int!, $id: String) {
        pools(
          first: $pageSize
          ${blockNumber ? `block: { number: ${blockNumber} }` : ``}
          where: { id_gt: $id }
        ) {
          id
          token0 {
            symbol
            id
          }
          token1 {
            symbol
            id
          }
          feeTier
          liquidity
          totalValueLockedUSD
          totalValueLockedAMB
        }
      }
    `;

    let pools: RawCLSubgraphPool[] = [];

    log.info(
      `Getting CL pools from the subgraph with page size ${PAGE_SIZE}${
        providerConfig?.blockNumber
          ? ` as of block ${providerConfig?.blockNumber}`
          : ''
      }.`
    );

    await retry(
      async () => {
        const timeout = new Timeout();

        const getPools = async (): Promise<RawCLSubgraphPool[]> => {
          let lastId = '';
          let pools: RawCLSubgraphPool[] = [];
          let poolsPage: RawCLSubgraphPool[] = [];

          do {
            const poolsResult = await this.client.request<{
              pools: RawCLSubgraphPool[];
            }>(query, {
              pageSize: PAGE_SIZE,
              id: lastId,
            });

            poolsPage = poolsResult.pools;

            pools = pools.concat(poolsPage);

            lastId = pools[pools.length - 1]!.id;
          } while (poolsPage.length > 0);

          return pools;
        };

        /* eslint-disable no-useless-catch */
        try {
          const getPoolsPromise = getPools();
          const timerPromise = timeout.set(this.timeout).then(() => {
            throw new Error(
              `Timed out getting pools from subgraph: ${this.timeout}`
            );
          });
          pools = await Promise.race([getPoolsPromise, timerPromise]);
          return;
        } catch (err) {
          throw err;
        } finally {
          timeout.clear();
        }
        /* eslint-enable no-useless-catch */
      },
      {
        retries: this.retries,
        onRetry: (err: Error, retry) => {
          if (
            this.rollback &&
            blockNumber &&
            _.includes(err.message, 'indexed up to')
          ) {
            blockNumber = blockNumber - 10;
            log.info(
              `Detected subgraph indexing error. Rolled back block number to: ${blockNumber}`
            );
          }
          pools = [];
          log.info(
            { err },
            `Failed to get pools from subgraph. Retry attempt: ${retry}`
          );
        },
      }
    );

    const poolsSanitized = pools
      .filter(
        (pool) =>
          parseInt(pool.liquidity) > 0 ||
          parseFloat(pool.totalValueLockedAMB) > 0.01
      )
      .map((pool) => {
        const { totalValueLockedAMB, totalValueLockedUSD, ...rest } = pool;

        return {
          ...rest,
          id: pool.id.toLowerCase(),
          token0: {
            id: pool.token0.id.toLowerCase(),
          },
          token1: {
            id: pool.token1.id.toLowerCase(),
          },
          tvlAMB: parseFloat(totalValueLockedAMB),
          tvlUSD: parseFloat(totalValueLockedUSD),
        };
      });

    log.info(
      `Got ${pools.length} CL pools from the subgraph. ${poolsSanitized.length} after filtering`
    );

    return poolsSanitized;
  }
}
