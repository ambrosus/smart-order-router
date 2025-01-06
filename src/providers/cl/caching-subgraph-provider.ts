import { ChainId } from '@airdao/astra-sdk-core';

import { ICache } from '../cache';

import { CLSubgraphPool, ICLSubgraphProvider } from './subgraph-provider';

/**
 * Provider for getting CL pools, with functionality for caching the results.
 *
 * @export
 * @class CachingCLSubgraphProvider
 */
export class CachingCLSubgraphProvider implements ICLSubgraphProvider {
  private SUBGRAPH_KEY = (chainId: ChainId) => `subgraph-pools-${chainId}`;

  /**
   * Creates an instance of CachingCLSubgraphProvider.
   * @param chainId The chain id to use.
   * @param subgraphProvider The provider to use to get the subgraph pools when not in the cache.
   * @param cache Cache instance to hold cached pools.
   */
  constructor(
    private chainId: ChainId,
    protected subgraphProvider: ICLSubgraphProvider,
    private cache: ICache<CLSubgraphPool[]>
  ) {}

  public async getPools(): Promise<CLSubgraphPool[]> {
    const cachedPools = await this.cache.get(this.SUBGRAPH_KEY(this.chainId));

    if (cachedPools) {
      return cachedPools;
    }

    const pools = await this.subgraphProvider.getPools();

    await this.cache.set(this.SUBGRAPH_KEY(this.chainId), pools);

    return pools;
  }
}
