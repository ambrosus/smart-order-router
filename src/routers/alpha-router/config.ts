import { ChainId } from '@airdao/astra-sdk-core';

import { AlphaRouterConfig, LowerCaseStringArray } from './alpha-router';

export const DEFAULT_ROUTING_CONFIG_BY_CHAIN = (
  _chainId: ChainId
): AlphaRouterConfig => {
  return {
    classicPoolSelection: {
      topN: 3,
      topNDirectSwaps: 1,
      topNTokenInOut: 5,
      topNSecondHop: 2,
      tokensToAvoidOnSecondHops: new LowerCaseStringArray(''),
      topNWithEachBaseToken: 2,
      topNWithBaseToken: 6,
    },
    clPoolSelection: {
      topN: 2,
      topNDirectSwaps: 2,
      topNTokenInOut: 3,
      topNSecondHop: 1,
      topNWithEachBaseToken: 3,
      topNWithBaseToken: 5,
    },
    maxSwapsPerPath: 3,
    minSplits: 1,
    maxSplits: 7,
    distributionPercent: 5,
    forceCrossProtocol: false,
  };
};
export const ETH_GAS_STATION_API_URL =
  'https://ethgasstation.info/api/ethgasAPI.json';
