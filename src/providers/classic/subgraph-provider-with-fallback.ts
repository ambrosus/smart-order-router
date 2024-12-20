import { Token } from '@airdao/astra-sdk-core';

import { log } from '../../util';
import { ProviderConfig } from '../provider';

import {
  ClassicSubgraphPool,
  IClassicSubgraphProvider,
} from './subgraph-provider';

/**
 * Provider for getting Classic subgraph pools that falls back to a different provider
 * in the event of failure.
 *
 * @export
 * @class ClassicSubgraphProviderWithFallBacks
 */
export class ClassicSubgraphProviderWithFallBacks
  implements IClassicSubgraphProvider
{
  /**
   * Creates an instance of ClassicSubgraphProviderWithFallBacks.
   * @param fallbacks Ordered list of `IClassicSubgraphProvider` to try to get pools from.
   */
  constructor(private fallbacks: IClassicSubgraphProvider[]) {}

  public async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<ClassicSubgraphPool[]> {
    for (let i = 0; i < this.fallbacks.length; i++) {
      const provider = this.fallbacks[i]!;
      try {
        const pools = await provider.getPools(
          tokenIn,
          tokenOut,
          providerConfig
        );
        return pools;
      } catch (err) {
        log.info(
          `Failed to get subgraph pools for Classic from fallback #${i}`
        );
      }
    }

    throw new Error('Failed to get subgraph pools from any providers');
  }
}
