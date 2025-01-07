import { Pool } from '@airdao/astra-cl-sdk';
import { ChainId, Price } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import _ from 'lodash';

import { WRAPPED_NATIVE_CURRENCY } from '../../../..';
import { ProviderConfig } from '../../../../providers/provider';
import { CurrencyAmount, log } from '../../../../util';
import { CLRouteWithValidQuote } from '../../entities';
import {
  BuildOnChainGasModelFactoryType,
  IGasModel,
  IOnChainGasModelFactory,
} from '../gas-model';

import {
  BASE_SWAP_COST,
  COST_PER_HOP,
  COST_PER_INIT_TICK,
  COST_PER_UNINIT_TICK,
  SINGLE_HOP_OVERHEAD,
  TOKEN_OVERHEAD,
} from './gas-costs';

/**
 * Computes a gas estimate for a CL swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the QuoterV2
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For Classic we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class CLHeuristicGasModelFactory
 */
export class CLHeuristicGasModelFactory extends IOnChainGasModelFactory {
  constructor() {
    super();
  }

  public async buildGasModel({
    chainId,
    gasPriceWei,
    pools,
    amountToken,
    quoteToken,
    providerConfig,
  }: BuildOnChainGasModelFactoryType): Promise<
    IGasModel<CLRouteWithValidQuote>
  > {
    const usdPool: Pool = pools.usdPool;

    // If our quote token is SAMB, we don't need to convert our gas use to be in terms
    // of the quote token in order to produce a gas adjusted amount.
    // We do return a gas use in USD however, so we still convert to usd.
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;
    if (quoteToken.equals(nativeCurrency)) {
      const estimateGasCost = (
        routeWithValidQuote: CLRouteWithValidQuote
      ): {
        gasEstimate: BigNumber;
        gasCostInToken: CurrencyAmount;
        gasCostInUSD: CurrencyAmount;
      } => {
        const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(
          routeWithValidQuote,
          gasPriceWei,
          chainId,
          providerConfig
        );

        const token0 = usdPool.token0.address == nativeCurrency.address;

        const nativeTokenPrice = token0
          ? usdPool.token0Price
          : usdPool.token1Price;

        const gasCostInTermsOfUSD: CurrencyAmount = nativeTokenPrice.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;

        return {
          gasEstimate: baseGasUse,
          gasCostInToken: totalGasCostNativeCurrency,
          gasCostInUSD: gasCostInTermsOfUSD,
        };
      };

      return {
        estimateGasCost,
      };
    }

    // If the quote token is not in the native currency, we convert the gas cost to be in terms of the quote token.
    // We do this by getting the highest liquidity <quoteToken>/<nativeCurrency> pool. eg. <quoteToken>/AMB pool.
    const nativePool: Pool | null = pools.nativeQuoteTokenCLPool;

    let nativeAmountPool: Pool | null = null;
    if (!amountToken.equals(nativeCurrency)) {
      nativeAmountPool = pools.nativeAmountTokenCLPool;
    }

    const usdToken =
      usdPool.token0.address == nativeCurrency.address
        ? usdPool.token1
        : usdPool.token0;

    const estimateGasCost = (
      routeWithValidQuote: CLRouteWithValidQuote
    ): {
      gasEstimate: BigNumber;
      gasCostInToken: CurrencyAmount;
      gasCostInUSD: CurrencyAmount;
    } => {
      const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(
        routeWithValidQuote,
        gasPriceWei,
        chainId,
        providerConfig
      );

      let gasCostInTermsOfQuoteToken: CurrencyAmount | null = null;
      if (nativePool) {
        const token0 = nativePool.token0.address == nativeCurrency.address;

        // returns mid price in terms of the native currency (the ratio of quoteToken/nativeToken)
        const nativeTokenPrice = token0
          ? nativePool.token0Price
          : nativePool.token1Price;

        try {
          // native token is base currency
          gasCostInTermsOfQuoteToken = nativeTokenPrice.quote(
            totalGasCostNativeCurrency
          ) as CurrencyAmount;
        } catch (err) {
          log.info(
            {
              nativeTokenPriceBase: nativeTokenPrice.baseCurrency,
              nativeTokenPriceQuote: nativeTokenPrice.quoteCurrency,
              gasCostInAmb: totalGasCostNativeCurrency.currency,
            },
            'Debug amb price token issue'
          );
          throw err;
        }
      }
      // we have a nativeAmountPool, but not a nativePool
      else {
        log.info(
          `Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol} to produce gas adjusted costs. Using amountToken to calculate gas costs.`
        );
      }

      // Highest liquidity pool for the non quote token / AMB
      // A pool with the non quote token / AMB should not be required and errors should be handled separately
      if (nativeAmountPool) {
        // get current execution price (amountToken / quoteToken)
        const executionPrice = new Price(
          routeWithValidQuote.amount.currency,
          routeWithValidQuote.quote.currency,
          routeWithValidQuote.amount.quotient,
          routeWithValidQuote.quote.quotient
        );

        const inputIsToken0 =
          nativeAmountPool.token0.address == nativeCurrency.address;
        // ratio of input / native
        const nativeAmountTokenPrice = inputIsToken0
          ? nativeAmountPool.token0Price
          : nativeAmountPool.token1Price;

        const gasCostInTermsOfAmountToken = nativeAmountTokenPrice.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;

        // Convert gasCostInTermsOfAmountToken to quote token using execution price
        const syntheticGasCostInTermsOfQuoteToken = executionPrice.quote(
          gasCostInTermsOfAmountToken
        );

        // Note that the syntheticGasCost being lessThan the original quoted value is not always strictly better
        // e.g. the scenario where the amountToken/AMB pool is very illiquid as well and returns an extremely small number
        // however, it is better to have the gasEstimation be almost 0 than almost infinity, as the user will still receive a quote
        if (
          gasCostInTermsOfQuoteToken === null ||
          syntheticGasCostInTermsOfQuoteToken.lessThan(
            gasCostInTermsOfQuoteToken.asFraction
          )
        ) {
          log.info(
            {
              nativeAmountTokenPrice: nativeAmountTokenPrice.toSignificant(6),
              gasCostInTermsOfQuoteToken: gasCostInTermsOfQuoteToken
                ? gasCostInTermsOfQuoteToken.toExact()
                : 0,
              gasCostInTermsOfAmountToken:
                gasCostInTermsOfAmountToken.toExact(),
              executionPrice: executionPrice.toSignificant(6),
              syntheticGasCostInTermsOfQuoteToken:
                syntheticGasCostInTermsOfQuoteToken.toSignificant(6),
            },
            'New gasCostInTermsOfQuoteToken calculated with synthetic quote token price is less than original'
          );

          gasCostInTermsOfQuoteToken = syntheticGasCostInTermsOfQuoteToken;
        }
      }

      // true if token0 is the native currency
      const token0USDPool = usdPool.token0.address == nativeCurrency.address;

      // gets the mid price of the pool in terms of the native token
      const nativeTokenPriceUSDPool = token0USDPool
        ? usdPool.token0Price
        : usdPool.token1Price;

      let gasCostInTermsOfUSD: CurrencyAmount;
      try {
        gasCostInTermsOfUSD = nativeTokenPriceUSDPool.quote(
          totalGasCostNativeCurrency
        ) as CurrencyAmount;
      } catch (err) {
        log.info(
          {
            usdT1: usdPool.token0.symbol,
            usdT2: usdPool.token1.symbol,
            gasCostInNativeToken: totalGasCostNativeCurrency.currency.symbol,
          },
          'Failed to compute USD gas price'
        );
        throw err;
      }

      // If gasCostInTermsOfQuoteToken is null, both attempts to calculate gasCostInTermsOfQuoteToken failed (nativePool and amountNativePool)
      if (gasCostInTermsOfQuoteToken === null) {
        log.info(
          `Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol}, or amount Token, ${amountToken.symbol} to produce gas adjusted costs. Route will not account for gas.`
        );
        return {
          gasEstimate: baseGasUse,
          gasCostInToken: CurrencyAmount.fromRawAmount(quoteToken, 0),
          gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
        };
      }

      return {
        gasEstimate: baseGasUse,
        gasCostInToken: gasCostInTermsOfQuoteToken,
        gasCostInUSD: gasCostInTermsOfUSD!,
      };
    };

    return {
      estimateGasCost: estimateGasCost.bind(this),
    };
  }

  private estimateGas(
    routeWithValidQuote: CLRouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId,
    providerConfig?: ProviderConfig
  ) {
    const totalInitializedTicksCrossed = BigNumber.from(
      Math.max(1, _.sum(routeWithValidQuote.initializedTicksCrossedList))
    );
    const totalHops = BigNumber.from(routeWithValidQuote.route.pools.length);

    let hopsGasUse = COST_PER_HOP(chainId).mul(totalHops);

    // We have observed that this algorithm tends to underestimate single hop swaps.
    // We add a buffer in the case of a single hop swap.
    if (totalHops.eq(1)) {
      hopsGasUse = hopsGasUse.add(SINGLE_HOP_OVERHEAD(chainId));
    }

    // Some tokens have extremely expensive transferFrom functions, which causes
    // us to underestimate them by a large amount. For known tokens, we apply an
    // adjustment.
    const tokenOverhead = TOKEN_OVERHEAD(chainId, routeWithValidQuote.route);

    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    // base estimate gas used based on chainId estimates for hops and ticks gas useage
    const baseGasUse = BASE_SWAP_COST(chainId)
      .add(hopsGasUse)
      .add(tokenOverhead)
      .add(tickGasUse)
      .add(uninitializedTickGasUse)
      .add(providerConfig?.additionalGasOverhead ?? BigNumber.from(0));

    const baseGasCostWei = gasPriceWei.mul(baseGasUse);

    const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const totalGasCostNativeCurrency = CurrencyAmount.fromRawAmount(
      wrappedCurrency,
      baseGasCostWei.toString()
    );

    return {
      totalGasCostNativeCurrency,
      totalInitializedTicksCrossed,
      baseGasUse,
    };
  }
}
