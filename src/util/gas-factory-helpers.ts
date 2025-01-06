import { FeeAmount, Pool } from '@airdao/astra-cl-sdk';
import { Pair } from '@airdao/astra-classic-sdk/dist/entities';
import { Protocol } from '@airdao/astra-router-sdk';
import {
  ChainId,
  Currency,
  CurrencyAmount,
  Token,
  TradeType,
} from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import JSBI from 'jsbi';
import _ from 'lodash';

import { IClassicPoolProvider, ICLPoolProvider } from '../providers';
import { IPortionProvider } from '../providers/portion-provider';
import { ProviderConfig } from '../providers/provider';
import {
  ClassicRouteWithValidQuote,
  CLRouteWithValidQuote,
  MethodParameters,
  MixedRouteWithValidQuote,
  SwapOptions,
  SwapRoute,
  usdGasTokensByChain,
} from '../routers';
import { log, WRAPPED_NATIVE_CURRENCY } from '../util';

import { buildTrade } from './methodParameters';

export async function getClassicNativePool(
  token: Token,
  poolProvider: IClassicPoolProvider,
  providerConfig?: ProviderConfig
): Promise<Pair | null> {
  const chainId = token.chainId as ChainId;
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
      `Could not find a valid SAMB Classic pool with ${token.symbol} for computing gas costs.`
    );

    return null;
  }

  return pool;
}

export async function getHighestLiquidityCLNativePool(
  token: Token,
  poolProvider: ICLPoolProvider,
  providerConfig?: ProviderConfig
): Promise<Pool | null> {
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[token.chainId as ChainId]!;

  const nativePools = _([
    FeeAmount.HIGH,
    FeeAmount.MEDIUM,
    FeeAmount.LOW,
    FeeAmount.LOWEST,
  ])
    .map<[Token, Token, FeeAmount]>((feeAmount) => {
      return [nativeCurrency, token, feeAmount];
    })
    .value();

  const poolAccessor = await poolProvider.getPools(nativePools, providerConfig);

  const pools = _([
    FeeAmount.HIGH,
    FeeAmount.MEDIUM,
    FeeAmount.LOW,
    FeeAmount.LOWEST,
  ])
    .map((feeAmount) => {
      return poolAccessor.getPool(nativeCurrency, token, feeAmount);
    })
    .compact()
    .value();

  if (pools.length == 0) {
    log.error(
      { pools },
      `Could not find a ${nativeCurrency.symbol} pool with ${token.symbol} for computing gas costs.`
    );

    return null;
  }

  const maxPool = pools.reduce((prev, current) => {
    return JSBI.greaterThan(prev.liquidity, current.liquidity) ? prev : current;
  });

  return maxPool;
}

export async function getHighestLiquidityCLUSDPool(
  chainId: ChainId,
  poolProvider: ICLPoolProvider,
  providerConfig?: ProviderConfig
): Promise<Pool> {
  const usdTokens = usdGasTokensByChain[chainId];
  const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId]!;

  if (!usdTokens) {
    throw new Error(
      `Could not find a USD token for computing gas costs on ${chainId}`
    );
  }

  const usdPools = _([
    FeeAmount.HIGH,
    FeeAmount.MEDIUM,
    FeeAmount.LOW,
    FeeAmount.LOWEST,
  ])
    .flatMap((feeAmount) => {
      return _.map<Token, [Token, Token, FeeAmount]>(usdTokens, (usdToken) => [
        wrappedCurrency,
        usdToken,
        feeAmount,
      ]);
    })
    .value();

  const poolAccessor = await poolProvider.getPools(usdPools, providerConfig);

  const pools = _([
    FeeAmount.HIGH,
    FeeAmount.MEDIUM,
    FeeAmount.LOW,
    FeeAmount.LOWEST,
  ])
    .flatMap((feeAmount) => {
      const pools = [];

      for (const usdToken of usdTokens) {
        const pool = poolAccessor.getPool(wrappedCurrency, usdToken, feeAmount);
        if (pool) {
          pools.push(pool);
        }
      }

      return pools;
    })
    .compact()
    .value();

  if (pools.length == 0) {
    const message = `Could not find a USD/${wrappedCurrency.symbol} pool for computing gas costs.`;
    log.error({ pools }, message);
    throw new Error(message);
  }

  const maxPool = pools.reduce((prev, current) => {
    return JSBI.greaterThan(prev.liquidity, current.liquidity) ? prev : current;
  });

  return maxPool;
}

export function getGasCostInUSD(
  usdPool: Pool,
  costNativeCurrency: CurrencyAmount<Token>
) {
  const nativeCurrency = costNativeCurrency.currency;
  // convert fee into usd
  const nativeTokenPrice =
    usdPool.token0.address == nativeCurrency.address
      ? usdPool.token0Price
      : usdPool.token1Price;

  const gasCostUSD = nativeTokenPrice.quote(costNativeCurrency);
  return gasCostUSD;
}

export function getGasCostInNativeCurrency(
  nativeCurrency: Token,
  gasCostInWei: BigNumber
) {
  // wrap fee to native currency
  const costNativeCurrency = CurrencyAmount.fromRawAmount(
    nativeCurrency,
    gasCostInWei.toString()
  );
  return costNativeCurrency;
}

export async function getGasCostInQuoteToken(
  quoteToken: Token,
  nativePool: Pool | Pair,
  costNativeCurrency: CurrencyAmount<Token>
) {
  const nativeTokenPrice =
    nativePool.token0.address == quoteToken.address
      ? nativePool.token1Price
      : nativePool.token0Price;
  const gasCostQuoteToken = nativeTokenPrice.quote(costNativeCurrency);
  return gasCostQuoteToken;
}

export async function calculateGasUsed(
  chainId: ChainId,
  route: SwapRoute,
  simulatedGasUsed: BigNumber,
  classicPoolProvider: IClassicPoolProvider,
  clPoolProvider: ICLPoolProvider,
  providerConfig?: ProviderConfig
) {
  const quoteToken = route.quote.currency.wrapped;
  const gasPriceWei = route.gasPriceWei;
  const feeInWei = BigNumber.from(0);

  const gasCostInWei = gasPriceWei.mul(simulatedGasUsed).add(feeInWei);
  const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
  const costNativeCurrency = getGasCostInNativeCurrency(
    nativeCurrency,
    gasCostInWei
  );

  const usdPool: Pool = await getHighestLiquidityCLUSDPool(
    chainId,
    clPoolProvider,
    providerConfig
  );

  const gasCostUSD = await getGasCostInUSD(usdPool, costNativeCurrency);

  let gasCostQuoteToken = costNativeCurrency;
  if (!quoteToken.equals(nativeCurrency)) {
    const nativePools = await Promise.all([
      getHighestLiquidityCLNativePool(
        quoteToken,
        clPoolProvider,
        providerConfig
      ),
      getClassicNativePool(quoteToken, classicPoolProvider, providerConfig),
    ]);
    const nativePool = nativePools.find((pool) => pool !== null);

    if (!nativePool) {
      log.info(
        'Could not find any Classic or CL pools to convert the cost into the quote token'
      );
      gasCostQuoteToken = CurrencyAmount.fromRawAmount(quoteToken, 0);
    } else {
      gasCostQuoteToken = await getGasCostInQuoteToken(
        quoteToken,
        nativePool,
        costNativeCurrency
      );
    }
  }

  // Adjust quote for gas fees
  let quoteGasAdjusted;
  if (route.trade.tradeType == TradeType.EXACT_OUTPUT) {
    // Exact output - need more of tokenIn to get the desired amount of tokenOut
    quoteGasAdjusted = route.quote.add(gasCostQuoteToken);
  } else {
    // Exact input - can get less of tokenOut due to fees
    quoteGasAdjusted = route.quote.subtract(gasCostQuoteToken);
  }

  return {
    estimatedGasUsedUSD: gasCostUSD,
    estimatedGasUsedQuoteToken: gasCostQuoteToken,
    quoteGasAdjusted: quoteGasAdjusted,
  };
}

export function initSwapRouteFromExisting(
  swapRoute: SwapRoute,
  classicPoolProvider: IClassicPoolProvider,
  clPoolProvider: ICLPoolProvider,
  portionProvider: IPortionProvider,
  quoteGasAdjusted: CurrencyAmount<Currency>,
  estimatedGasUsed: BigNumber,
  estimatedGasUsedQuoteToken: CurrencyAmount<Currency>,
  estimatedGasUsedUSD: CurrencyAmount<Currency>,
  swapOptions: SwapOptions
): SwapRoute {
  const currencyIn = swapRoute.trade.inputAmount.currency;
  const currencyOut = swapRoute.trade.outputAmount.currency;
  const tradeType = swapRoute.trade.tradeType.valueOf()
    ? TradeType.EXACT_OUTPUT
    : TradeType.EXACT_INPUT;
  const routesWithValidQuote = swapRoute.route.map((route) => {
    switch (route.protocol) {
      case Protocol.CL:
        return new CLRouteWithValidQuote({
          amount: CurrencyAmount.fromFractionalAmount(
            route.amount.currency,
            route.amount.numerator,
            route.amount.denominator
          ),
          rawQuote: BigNumber.from(route.rawQuote),
          sqrtPriceX96AfterList: route.sqrtPriceX96AfterList.map((num) =>
            BigNumber.from(num)
          ),
          initializedTicksCrossedList: [...route.initializedTicksCrossedList],
          quoterGasEstimate: BigNumber.from(route.gasEstimate),
          percent: route.percent,
          route: route.route,
          gasModel: route.gasModel,
          quoteToken: new Token(
            currencyIn.chainId,
            route.quoteToken.address,
            route.quoteToken.decimals,
            route.quoteToken.symbol,
            route.quoteToken.name
          ),
          tradeType: tradeType,
          clPoolProvider: clPoolProvider,
        });
      case Protocol.Classic:
        return new ClassicRouteWithValidQuote({
          amount: CurrencyAmount.fromFractionalAmount(
            route.amount.currency,
            route.amount.numerator,
            route.amount.denominator
          ),
          rawQuote: BigNumber.from(route.rawQuote),
          percent: route.percent,
          route: route.route,
          gasModel: route.gasModel,
          quoteToken: new Token(
            currencyIn.chainId,
            route.quoteToken.address,
            route.quoteToken.decimals,
            route.quoteToken.symbol,
            route.quoteToken.name
          ),
          tradeType: tradeType,
          classicPoolProvider,
        });
      case Protocol.MIXED:
        return new MixedRouteWithValidQuote({
          amount: CurrencyAmount.fromFractionalAmount(
            route.amount.currency,
            route.amount.numerator,
            route.amount.denominator
          ),
          rawQuote: BigNumber.from(route.rawQuote),
          sqrtPriceX96AfterList: route.sqrtPriceX96AfterList.map((num) =>
            BigNumber.from(num)
          ),
          initializedTicksCrossedList: [...route.initializedTicksCrossedList],
          quoterGasEstimate: BigNumber.from(route.gasEstimate),
          percent: route.percent,
          route: route.route,
          mixedRouteGasModel: route.gasModel,
          classicPoolProvider: classicPoolProvider,
          quoteToken: new Token(
            currencyIn.chainId,
            route.quoteToken.address,
            route.quoteToken.decimals,
            route.quoteToken.symbol,
            route.quoteToken.name
          ),
          tradeType: tradeType,
          clPoolProvider: clPoolProvider,
        });
    }
  });
  const trade = buildTrade<typeof tradeType>(
    currencyIn,
    currencyOut,
    tradeType,
    routesWithValidQuote
  );

  const quoteGasAndPortionAdjusted = swapRoute.portionAmount
    ? portionProvider.getQuoteGasAndPortionAdjusted(
        swapRoute.trade.tradeType,
        quoteGasAdjusted,
        swapRoute.portionAmount
      )
    : undefined;
  const routesWithValidQuotePortionAdjusted =
    portionProvider.getRouteWithQuotePortionAdjusted(
      swapRoute.trade.tradeType,
      routesWithValidQuote,
      swapOptions
    );

  return {
    quote: swapRoute.quote,
    quoteGasAdjusted,
    quoteGasAndPortionAdjusted,
    estimatedGasUsed,
    estimatedGasUsedQuoteToken,
    estimatedGasUsedUSD,
    gasPriceWei: BigNumber.from(swapRoute.gasPriceWei),
    trade,
    route: routesWithValidQuotePortionAdjusted,
    blockNumber: BigNumber.from(swapRoute.blockNumber),
    methodParameters: swapRoute.methodParameters
      ? ({
          calldata: swapRoute.methodParameters.calldata,
          value: swapRoute.methodParameters.value,
          to: swapRoute.methodParameters.to,
        } as MethodParameters)
      : undefined,
    simulationStatus: swapRoute.simulationStatus,
    portionAmount: swapRoute.portionAmount,
  };
}
