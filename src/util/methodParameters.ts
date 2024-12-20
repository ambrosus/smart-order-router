import { Route as CLRouteRaw } from '@airdao/astra-cl-sdk';
import { Route as ClassicRouteRaw } from '@airdao/astra-classic-sdk';
import {
  MixedRouteSDK,
  Protocol,
  SwapRouter as SwapRouter02,
  Trade,
} from '@airdao/astra-router-sdk';
import { ChainId, Currency, TradeType } from '@airdao/astra-sdk-core';
import {
  SwapRouter as UniveralRouter,
  UNIVERSAL_ROUTER_ADDRESS,
} from '@airdao/universal-router-sdk';
import _ from 'lodash';

import {
  ClassicRouteWithValidQuote,
  CLRouteWithValidQuote,
  CurrencyAmount,
  MethodParameters,
  MixedRouteWithValidQuote,
  RouteWithValidQuote,
  SwapOptions,
  SwapType,
  SWAP_ROUTER_02_ADDRESSES,
} from '..';

export function buildTrade<TTradeType extends TradeType>(
  tokenInCurrency: Currency,
  tokenOutCurrency: Currency,
  tradeType: TTradeType,
  routeAmounts: RouteWithValidQuote[]
): Trade<Currency, Currency, TTradeType> {
  /// Removed partition because of new mixedRoutes
  const clRouteAmounts = _.filter(
    routeAmounts,
    (routeAmount) => routeAmount.protocol === Protocol.CL
  );
  const classicRouteAmounts = _.filter(
    routeAmounts,
    (routeAmount) => routeAmount.protocol === Protocol.Classic
  );
  const mixedRouteAmounts = _.filter(
    routeAmounts,
    (routeAmount) => routeAmount.protocol === Protocol.MIXED
  );

  const clRoutes = _.map<
    CLRouteWithValidQuote,
    {
      routecl: CLRouteRaw<Currency, Currency>;
      inputAmount: CurrencyAmount;
      outputAmount: CurrencyAmount;
    }
  >(
    clRouteAmounts as CLRouteWithValidQuote[],
    (routeAmount: CLRouteWithValidQuote) => {
      const { route, amount, quote } = routeAmount;

      // The route, amount and quote are all in terms of wrapped tokens.
      // When constructing the Trade object the inputAmount/outputAmount must
      // use native currencies if specified by the user. This is so that the Trade knows to wrap/unwrap.
      if (tradeType == TradeType.EXACT_INPUT) {
        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          amount.numerator,
          amount.denominator
        );
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          quote.numerator,
          quote.denominator
        );

        const routeRaw = new CLRouteRaw(
          route.pools,
          amountCurrency.currency,
          quoteCurrency.currency
        );

        return {
          routecl: routeRaw,
          inputAmount: amountCurrency,
          outputAmount: quoteCurrency,
        };
      } else {
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          quote.numerator,
          quote.denominator
        );

        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          amount.numerator,
          amount.denominator
        );

        const routeCurrency = new CLRouteRaw(
          route.pools,
          quoteCurrency.currency,
          amountCurrency.currency
        );

        return {
          routecl: routeCurrency,
          inputAmount: quoteCurrency,
          outputAmount: amountCurrency,
        };
      }
    }
  );

  const classicRoutes = _.map<
    ClassicRouteWithValidQuote,
    {
      routeclassic: ClassicRouteRaw<Currency, Currency>;
      inputAmount: CurrencyAmount;
      outputAmount: CurrencyAmount;
    }
  >(
    classicRouteAmounts as ClassicRouteWithValidQuote[],
    (routeAmount: ClassicRouteWithValidQuote) => {
      const { route, amount, quote } = routeAmount;

      // The route, amount and quote are all in terms of wrapped tokens.
      // When constructing the Trade object the inputAmount/outputAmount must
      // use native currencies if specified by the user. This is so that the Trade knows to wrap/unwrap.
      if (tradeType == TradeType.EXACT_INPUT) {
        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          amount.numerator,
          amount.denominator
        );
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          quote.numerator,
          quote.denominator
        );

        const routeClassicSDK = new ClassicRouteRaw(
          route.pairs,
          amountCurrency.currency,
          quoteCurrency.currency
        );

        return {
          routeclassic: routeClassicSDK,
          inputAmount: amountCurrency,
          outputAmount: quoteCurrency,
        };
      } else {
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          quote.numerator,
          quote.denominator
        );

        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          amount.numerator,
          amount.denominator
        );

        const routeClassicSDK = new ClassicRouteRaw(
          route.pairs,
          quoteCurrency.currency,
          amountCurrency.currency
        );

        return {
          routeclassic: routeClassicSDK,
          inputAmount: quoteCurrency,
          outputAmount: amountCurrency,
        };
      }
    }
  );

  const mixedRoutes = _.map<
    MixedRouteWithValidQuote,
    {
      mixedRoute: MixedRouteSDK<Currency, Currency>;
      inputAmount: CurrencyAmount;
      outputAmount: CurrencyAmount;
    }
  >(
    mixedRouteAmounts as MixedRouteWithValidQuote[],
    (routeAmount: MixedRouteWithValidQuote) => {
      const { route, amount, quote } = routeAmount;

      if (tradeType != TradeType.EXACT_INPUT) {
        throw new Error(
          'Mixed routes are only supported for exact input trades'
        );
      }

      // The route, amount and quote are all in terms of wrapped tokens.
      // When constructing the Trade object the inputAmount/outputAmount must
      // use native currencies if specified by the user. This is so that the Trade knows to wrap/unwrap.
      const amountCurrency = CurrencyAmount.fromFractionalAmount(
        tokenInCurrency,
        amount.numerator,
        amount.denominator
      );
      const quoteCurrency = CurrencyAmount.fromFractionalAmount(
        tokenOutCurrency,
        quote.numerator,
        quote.denominator
      );

      const routeRaw = new MixedRouteSDK(
        route.pools,
        amountCurrency.currency,
        quoteCurrency.currency
      );

      return {
        mixedRoute: routeRaw,
        inputAmount: amountCurrency,
        outputAmount: quoteCurrency,
      };
    }
  );

  const trade = new Trade({ classicRoutes, clRoutes, mixedRoutes, tradeType });

  return trade;
}

export function buildSwapMethodParameters(
  trade: Trade<Currency, Currency, TradeType>,
  swapConfig: SwapOptions,
  chainId: ChainId
): MethodParameters {
  if (swapConfig.type == SwapType.UNIVERSAL_ROUTER) {
    return {
      ...UniveralRouter.swapERC20CallParameters(trade, swapConfig),
      to: UNIVERSAL_ROUTER_ADDRESS(chainId),
    };
  } else if (swapConfig.type == SwapType.SWAP_ROUTER_02) {
    const { recipient, slippageTolerance, deadline, inputTokenPermit } =
      swapConfig;

    return {
      ...SwapRouter02.swapCallParameters(trade, {
        recipient,
        slippageTolerance,
        deadlineOrPreviousBlockhash: deadline,
        inputTokenPermit,
      }),
      to: SWAP_ROUTER_02_ADDRESSES(chainId),
    };
  }

  throw new Error(`Unsupported swap type ${swapConfig}`);
}
