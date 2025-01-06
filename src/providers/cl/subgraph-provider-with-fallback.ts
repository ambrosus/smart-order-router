import { Token } from '@airdao/astra-sdk-core';

import { log } from '../../util';
import { ProviderConfig } from '../provider';

import { CLSubgraphPool, ICLSubgraphProvider } from './subgraph-provider';

/**
 * Provider for getting CL subgraph pools that falls back to a different provider
 * in the event of failure.
 *
 * @export
 * @class CLSubgraphProviderWithFallBacks
 */
export class CLSubgraphProviderWithFallBacks implements ICLSubgraphProvider {
  constructor(private fallbacks: ICLSubgraphProvider[]) {}

  public async getPools(
    tokenIn?: Token,
    tokenOut?: Token,
    providerConfig?: ProviderConfig
  ): Promise<CLSubgraphPool[]> {
    for (let i = 0; i < this.fallbacks.length; i++) {
      const provider = this.fallbacks[i]!;
      try {
        return await provider.getPools(tokenIn, tokenOut, providerConfig);
      } catch (err) {
        log.info(`Failed to get subgraph pools for CL from fallback #${i}`);
      }
    }

    throw new Error('Failed to get subgraph pools from any providers');
  }
}
