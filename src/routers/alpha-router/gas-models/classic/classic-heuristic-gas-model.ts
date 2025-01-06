import { Pair } from '@airdao/astra-classic-sdk';
import { ChainId, Token } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import _ from 'lodash';

import { IClassicPoolProvider } from '../../../../providers';
import { ProviderConfig } from '../../../../providers/provider';
import { CurrencyAmount, log, WRAPPED_NATIVE_CURRENCY } from '../../../../util';
import { ClassicRouteWithValidQuote } from '../../entities';
import {
  BuildClassicGasModelFactoryType,
  IClassicGasModelFactory,
  IGasModel,
  usdGasTokensByChain,
} from '../gas-model';

// Constant cost for doing any swap regardless of pools.
export const BASE_SWAP_COST = BigNumber.from(135000); // 115000, bumped up by 20_000 @eric 7/8/2022

// Constant per extra hop in the route.
export const COST_PER_EXTRA_HOP = BigNumber.from(50000); // 20000, bumped up by 30_000 @eric 7/8/2022

/**
 * Computes a gas estimate for a Classic swap using heuristics.
 * Considers number of hops in the route and the typical base cost for a swap.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For Classic we simulate all our swaps off-chain so have no way to track gas used.
 *
 * Note, certain tokens e.g. rebasing/fee-on-transfer, may incur higher gas costs than
 * what we estimate here. This is because they run extra logic on token transfer.
 *
 * @export
 * @class ClassicHeuristicGasModelFactory
 */
export class ClassicHeuristicGasModelFactory extends IClassicGasModelFactory {
  constructor() {
    super();
  }

  public async buildGasModel({
    chainId,
    gasPriceWei,
    poolProvider,
    token,
    providerConfig,
  }: BuildClassicGasModelFactoryType): Promise<
    IGasModel<ClassicRouteWithValidQuote>
  > {
    if (token.equals(WRAPPED_NATIVE_CURRENCY[chainId]!)) {
      const usdPool: Pair = await this.getHighestLiquidityUSDPool(
        chainId,
        poolProvider,
        providerConfig
      );

      return {
        estimateGasCost: (routeWithValidQuote: ClassicRouteWithValidQuote) => {
          const { gasCostInAmb, gasUse } = this.estimateGas(
            routeWithValidQuote,
            gasPriceWei,
            chainId,
            providerConfig
          );

          const ambToken0 =
            usdPool.token0.address == WRAPPED_NATIVE_CURRENCY[chainId]!.address;

          const ambTokenPrice = ambToken0
            ? usdPool.token0Price
            : usdPool.token1Price;

          const gasCostInTermsOfUSD: CurrencyAmount = ambTokenPrice.quote(
            gasCostInAmb
          ) as CurrencyAmount;

          return {
            gasEstimate: gasUse,
            gasCostInToken: gasCostInAmb,
            gasCostInUSD: gasCostInTermsOfUSD,
          };
        },
      };
    }

    // If the quote token is not SAMB, we convert the gas cost to be in terms of the quote token.
    // We do this by getting the highest liquidity <token>/AMB pool.
    const ambPoolPromise = this.getAmbPool(
      chainId,
      token,
      poolProvider,
      providerConfig
    );

    const usdPoolPromise = this.getHighestLiquidityUSDPool(
      chainId,
      poolProvider,
      providerConfig
    );

    const [ambPool, usdPool] = await Promise.all([
      ambPoolPromise,
      usdPoolPromise,
    ]);

    if (!ambPool) {
      log.info(
        'Unable to find AMB pool with the quote token to produce gas adjusted costs. Route will not account for gas.'
      );
    }

    return {
      estimateGasCost: (routeWithValidQuote: ClassicRouteWithValidQuote) => {
        const usdToken =
          usdPool.token0.address == WRAPPED_NATIVE_CURRENCY[chainId]!.address
            ? usdPool.token1
            : usdPool.token0;

        const { gasCostInAmb, gasUse } = this.estimateGas(
          routeWithValidQuote,
          gasPriceWei,
          chainId,
          {
            ...providerConfig,
          }
        );

        if (!ambPool) {
          return {
            gasEstimate: gasUse,
            gasCostInToken: CurrencyAmount.fromRawAmount(token, 0),
            gasCostInUSD: CurrencyAmount.fromRawAmount(usdToken, 0),
          };
        }

        const ambToken0 =
          ambPool.token0.address == WRAPPED_NATIVE_CURRENCY[chainId]!.address;

        const ambTokenPrice = ambToken0
          ? ambPool.token0Price
          : ambPool.token1Price;

        let gasCostInTermsOfQuoteToken: CurrencyAmount;
        try {
          gasCostInTermsOfQuoteToken = ambTokenPrice.quote(
            gasCostInAmb
          ) as CurrencyAmount;
        } catch (err) {
          log.error(
            {
              ambTokenPriceBase: ambTokenPrice.baseCurrency,
              ambTokenPriceQuote: ambTokenPrice.quoteCurrency,
              gasCostInAmb: gasCostInAmb.currency,
            },
            'Debug amb price token issue'
          );
          throw err;
        }

        const ambToken0USDPool =
          usdPool.token0.address == WRAPPED_NATIVE_CURRENCY[chainId]!.address;

        const ambTokenPriceUSDPool = ambToken0USDPool
          ? usdPool.token0Price
          : usdPool.token1Price;

        let gasCostInTermsOfUSD: CurrencyAmount;
        try {
          gasCostInTermsOfUSD = ambTokenPriceUSDPool.quote(
            gasCostInAmb
          ) as CurrencyAmount;
        } catch (err) {
          log.error(
            {
              usdT1: usdPool.token0.symbol,
              usdT2: usdPool.token1.symbol,
              gasCostInAmbToken: gasCostInAmb.currency.symbol,
            },
            'Failed to compute USD gas price'
          );
          throw err;
        }

        return {
          gasEstimate: gasUse,
          gasCostInToken: gasCostInTermsOfQuoteToken,
          gasCostInUSD: gasCostInTermsOfUSD!,
        };
      },
    };
  }

  private estimateGas(
    routeWithValidQuote: ClassicRouteWithValidQuote,
    gasPriceWei: BigNumber,
    chainId: ChainId,
    providerConfig?: ProviderConfig
  ) {
    const hops = routeWithValidQuote.route.pairs.length;
    let gasUse = BASE_SWAP_COST.add(COST_PER_EXTRA_HOP.mul(hops - 1));

    if (providerConfig?.additionalGasOverhead) {
      gasUse = gasUse.add(providerConfig.additionalGasOverhead);
    }

    const totalGasCostWei = gasPriceWei.mul(gasUse);

    const samb = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const gasCostInAmb = CurrencyAmount.fromRawAmount(
      samb,
      totalGasCostWei.toString()
    );

    return { gasCostInAmb, gasUse };
  }

  private async getAmbPool(
    chainId: ChainId,
    token: Token,
    poolProvider: IClassicPoolProvider,
    providerConfig?: ProviderConfig
  ): Promise<Pair | null> {
    const samb = WRAPPED_NATIVE_CURRENCY[chainId]!;

    const poolAccessor = await poolProvider.getPools(
      [[samb, token]],
      providerConfig
    );
    const pool = poolAccessor.getPool(samb, token);

    if (!pool || pool.reserve0.equalTo(0) || pool.reserve1.equalTo(0)) {
      log.error(
        {
          samb,
          token,
          reserve0: pool?.reserve0.toExact(),
          reserve1: pool?.reserve1.toExact(),
        },
        `Could not find a valid SAMB pool with ${token.symbol} for computing gas costs.`
      );

      return null;
    }

    return pool;
  }

  private async getHighestLiquidityUSDPool(
    chainId: ChainId,
    poolProvider: IClassicPoolProvider,
    providerConfig?: ProviderConfig
  ): Promise<Pair> {
    const usdTokens = usdGasTokensByChain[chainId];

    if (!usdTokens) {
      throw new Error(
        `Could not find a USD token for computing gas costs on ${chainId}`
      );
    }

    const usdPools = _.map<Token, [Token, Token]>(usdTokens, (usdToken) => [
      usdToken,
      WRAPPED_NATIVE_CURRENCY[chainId]!,
    ]);
    const poolAccessor = await poolProvider.getPools(usdPools, providerConfig);
    const poolsRaw = poolAccessor.getAllPools();
    const pools = _.filter(
      poolsRaw,
      (pool) => pool.reserve0.greaterThan(0) && pool.reserve1.greaterThan(0)
    );

    if (pools.length == 0) {
      log.error(
        { pools },
        `Could not find a USD/SAMB pool for computing gas costs.`
      );
      throw new Error(`Can't find USD/SAMB pool for computing gas costs.`);
    }

    const maxPool = _.maxBy(pools, (pool) => {
      if (pool.token0.equals(WRAPPED_NATIVE_CURRENCY[chainId]!)) {
        return parseFloat(pool.reserve0.toSignificant(2));
      } else {
        return parseFloat(pool.reserve1.toSignificant(2));
      }
    }) as Pair;

    return maxPool;
  }
}
