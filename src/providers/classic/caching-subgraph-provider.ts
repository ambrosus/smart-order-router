import { ChainId } from '@airdao/astra-sdk-core';

import { ICache } from './../cache';
import {
  ClassicSubgraphPool,
  IClassicSubgraphProvider,
} from './subgraph-provider';

/**
 * Provider for getting Classic pools, with functionality for caching the results.
 *
 * @export
 * @class CachingClassicSubgraphProvider
 */
export class CachingClassicSubgraphProvider
  implements IClassicSubgraphProvider
{
  private SUBGRAPH_KEY = (chainId: ChainId) =>
    `subgraph-pools-classic-${chainId}`;

  /**
   * Creates an instance of CachingClassicSubgraphProvider.
   * @param chainId The chain id to use.
   * @param subgraphProvider The provider to use to get the subgraph pools when not in the cache.
   * @param cache Cache instance to hold cached pools.
   */
  constructor(
    private chainId: ChainId,
    protected subgraphProvider: IClassicSubgraphProvider,
    private cache: ICache<ClassicSubgraphPool[]>
  ) {}

  public async getPools(): Promise<ClassicSubgraphPool[]> {
    const cachedPools = await this.cache.get(this.SUBGRAPH_KEY(this.chainId));

    if (cachedPools) {
      return cachedPools;
    }

    const pools = await this.subgraphProvider.getPools();

    await this.cache.set(this.SUBGRAPH_KEY(this.chainId), pools);

    return pools;
  }
}
