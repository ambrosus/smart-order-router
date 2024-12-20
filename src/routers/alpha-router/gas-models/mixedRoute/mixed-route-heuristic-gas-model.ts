import { Pool } from '@airdao/astra-cl-sdk';
import { Pair } from '@airdao/astra-classic-sdk';
import { partitionMixedRouteByProtocol } from '@airdao/astra-router-sdk';
import { ChainId } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import JSBI from 'jsbi';
import _ from 'lodash';

import { WRAPPED_NATIVE_CURRENCY } from '../../../..';
import { ProviderConfig } from '../../../../providers/provider';
import { log } from '../../../../util';
import { CurrencyAmount } from '../../../../util/amounts';
import { getClassicNativePool } from '../../../../util/gas-factory-helpers';
import { MixedRouteWithValidQuote } from '../../entities/route-with-valid-quote';
import {
  BASE_SWAP_COST,
  COST_PER_HOP,
  COST_PER_INIT_TICK,
  COST_PER_UNINIT_TICK,
} from '../cl/gas-costs';
import {
  BASE_SWAP_COST as BASE_SWAP_COST_CLASSIC,
  COST_PER_EXTRA_HOP as COST_PER_EXTRA_HOP_CLASSIC,
} from '../classic/classic-heuristic-gas-model';
import {
  BuildOnChainGasModelFactoryType,
  IGasModel,
  IOnChainGasModelFactory,
} from '../gas-model';

/**
 * Computes a gas estimate for a mixed route swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the MixedRouteQuoterV1
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For CL we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class MixedRouteHeuristicGasModelFactory
 */
export class MixedRouteHeuristicGasModelFactory extends IOnChainGasModelFactory {
  constructor() {
    super();
  }

  public async buildGasModel({
    chainId,
    gasPriceWei,
    pools,
    quoteToken,
    classicPoolProvider: ClassicPoolProvider,
    providerConfig,
  }: BuildOnChainGasModelFactoryType): Promise<
    IGasModel<MixedRouteWithValidQuote>
  > {
    const usdPool: Pool = pools.usdPool;

    // If our quote token is SAMB, we don't need to convert our gas use to be in terms
    // of the quote token in order to produce a gas adjusted amount.
    // We do return a gas use in USD however, so we still convert to usd.
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;
    if (quoteToken.equals(nativeCurrency)) {
      const estimateGasCost = (
        routeWithValidQuote: MixedRouteWithValidQuote
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
    const nativeCLPool: Pool | null = pools.nativeQuoteTokenCLPool;

    let nativeClassicPool: Pair | null;
    if (ClassicPoolProvider) {
      /// MixedRoutes
      nativeClassicPool = await getClassicNativePool(
        quoteToken,
        ClassicPoolProvider,
        providerConfig
      );
    }

    const usdToken =
      usdPool.token0.address == nativeCurrency.address
        ? usdPool.token1
        : usdPool.token0;

    const estimateGasCost = (
      routeWithValidQuote: MixedRouteWithValidQuote
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

      if (!nativeCLPool && !nativeClassicPool) {
        log.info(
          `Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol} to produce gas adjusted costs. Route will not account for gas.`
        );
        return {
          gasEstimate: baseGasUse,
          gasCostInToken: CurrencyAmount.fromRawAmount(quoteToken, 0),
          gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
        };
      }

      /// we will use nativeClassicPool for fallback if nativeCL does not exist or has 0 liquidity
      /// can use ! here because we return above if clPool and classicPool are null
      const nativePool =
        (!nativeCLPool || JSBI.equal(nativeCLPool.liquidity, JSBI.BigInt(0))) &&
        nativeClassicPool
          ? nativeClassicPool
          : nativeCLPool!;

      const token0 = nativePool.token0.address == nativeCurrency.address;

      // returns mid price in terms of the native currency (the ratio of quoteToken/nativeToken)
      const nativeTokenPrice = token0
        ? nativePool.token0Price
        : nativePool.token1Price;

      let gasCostInTermsOfQuoteToken: CurrencyAmount;
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
    routeWithValidQuote: MixedRouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId,
    providerConfig?: ProviderConfig
  ) {
    const totalInitializedTicksCrossed = BigNumber.from(
      Math.max(1, _.sum(routeWithValidQuote.initializedTicksCrossedList))
    );
    /**
     * Since we must make a separate call to multicall for each CL and Classic section, we will have to
     * add the BASE_SWAP_COST to each section.
     */
    let baseGasUse = BigNumber.from(0);

    const route = routeWithValidQuote.route;

    const res = partitionMixedRouteByProtocol(route);
    res.map((section: (Pair | Pool)[]) => {
      if (section.every((pool) => pool instanceof Pool)) {
        baseGasUse = baseGasUse.add(BASE_SWAP_COST(chainId));
        baseGasUse = baseGasUse.add(COST_PER_HOP(chainId).mul(section.length));
      } else if (section.every((pool) => pool instanceof Pair)) {
        baseGasUse = baseGasUse.add(BASE_SWAP_COST_CLASSIC);
        baseGasUse = baseGasUse.add(
          /// same behavior in Classic heuristic gas model factory
          COST_PER_EXTRA_HOP_CLASSIC.mul(section.length - 1)
        );
      }
    });

    const tickGasUse = COST_PER_INIT_TICK(chainId).mul(
      totalInitializedTicksCrossed
    );
    const uninitializedTickGasUse = COST_PER_UNINIT_TICK.mul(0);

    // base estimate gas used based on chainId estimates for hops and ticks gas useage
    baseGasUse = baseGasUse.add(tickGasUse).add(uninitializedTickGasUse);

    if (providerConfig?.additionalGasOverhead) {
      baseGasUse = baseGasUse.add(providerConfig.additionalGasOverhead);
    }

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
