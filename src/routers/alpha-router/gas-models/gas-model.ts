import { Pool } from '@airdao/astra-cl-sdk';
import { ChainId, Token } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';

import { IClassicPoolProvider, USDC_ON } from '../../../providers';
import { ProviderConfig } from '../../../providers/provider';
import { CurrencyAmount } from '../../../util';
import {
  ClassicRouteWithValidQuote,
  CLRouteWithValidQuote,
  MixedRouteWithValidQuote,
  RouteWithValidQuote,
} from '../entities';

// When adding new usd gas tokens, ensure the tokens are ordered
// from tokens with the highest decimals to the lowest decimals.
export const usdGasTokensByChain: { [chainId in ChainId]?: Token[] } = {
  [ChainId.MAINNET]: [USDC_ON(ChainId.MAINNET)!],
  [ChainId.TESTNET]: [USDC_ON(ChainId.TESTNET)!],
  // [ChainId.DEVNET]: [USDC_ON(ChainId.DEVNET)!], // TODO: Uncomment and add the address when available
};

export type BuildOnChainGasModelFactoryType = {
  chainId: ChainId;
  gasPriceWei: BigNumber;
  pools: LiquidityCalculationPools;
  amountToken: Token;
  quoteToken: Token;
  classicPoolProvider: IClassicPoolProvider;
  providerConfig?: ProviderConfig;
};

export type BuildClassicGasModelFactoryType = {
  chainId: ChainId;
  gasPriceWei: BigNumber;
  poolProvider: IClassicPoolProvider;
  token: Token;
  providerConfig?: ProviderConfig;
};

export type LiquidityCalculationPools = {
  usdPool: Pool;
  nativeQuoteTokenCLPool: Pool | null;
  nativeAmountTokenCLPool: Pool | null;
};

/**
 * Contains functions for generating gas estimates for given routes.
 *
 * We generally compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used a wrapper contract is not accurate with Multicall
 *     due to EIP-2929
 *  3/ For Classic we simulate all our swaps off-chain so have no way to track gas used.
 *
 * Generally, these models should be optimized to return quickly by performing any
 * long-running operations (like fetching external data) outside the functions defined.
 * This is because the functions in the model are called once for every route and every
 * amount that is considered in the algorithm, so it is important to minimize the number of
 * long-running operations.
 */
export type IGasModel<TRouteWithValidQuote extends RouteWithValidQuote> = {
  estimateGasCost(routeWithValidQuote: TRouteWithValidQuote): {
    gasEstimate: BigNumber;
    gasCostInToken: CurrencyAmount;
    gasCostInUSD: CurrencyAmount;
  };
};

/**
 * Factory for building gas models that can be used with any route to generate
 * gas estimates.
 *
 * Factory model is used so that any supporting data can be fetched once and
 * returned as part of the model.
 *
 * @export
 * @abstract
 * @class IClassicGasModelFactory
 */
export abstract class IClassicGasModelFactory {
  public abstract buildGasModel({
    chainId,
    gasPriceWei,
    poolProvider,
    token,
    providerConfig,
  }: BuildClassicGasModelFactoryType): Promise<
    IGasModel<ClassicRouteWithValidQuote>
  >;
}

/**
 * Factory for building gas models that can be used with any route to generate
 * gas estimates.
 *
 * Factory model is used so that any supporting data can be fetched once and
 * returned as part of the model.
 *
 * @export
 * @abstract
 * @class IOnChainGasModelFactory
 */
export abstract class IOnChainGasModelFactory {
  public abstract buildGasModel({
    chainId,
    gasPriceWei,
    pools: LiquidityCalculationPools,
    amountToken,
    quoteToken,
    classicPoolProvider: ClassicPoolProvider,
    providerConfig,
  }: BuildOnChainGasModelFactoryType): Promise<
    IGasModel<CLRouteWithValidQuote | MixedRouteWithValidQuote>
  >;
}
