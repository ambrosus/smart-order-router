import {
  InsufficientInputAmountError,
  InsufficientReservesError,
} from '@airdao/astra-classic-sdk';
import { TradeType } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';

import { ClassicRoute } from '../../routers';
import { CurrencyAmount, log, routeToString } from '../../util';
import { ProviderConfig } from '../provider';

// Quotes can be null (e.g. pool did not have enough liquidity).
export type ClassicAmountQuote = {
  amount: CurrencyAmount;
  quote: BigNumber | null;
};

export type ClassicRouteWithQuotes = [ClassicRoute, ClassicAmountQuote[]];

export interface IClassicQuoteProvider {
  getQuotesManyExactIn(
    amountIns: CurrencyAmount[],
    routes: ClassicRoute[],
    providerConfig: ProviderConfig
  ): Promise<{ routesWithQuotes: ClassicRouteWithQuotes[] }>;

  getQuotesManyExactOut(
    amountOuts: CurrencyAmount[],
    routes: ClassicRoute[],
    providerConfig: ProviderConfig
  ): Promise<{ routesWithQuotes: ClassicRouteWithQuotes[] }>;
}

/**
 * Computes quotes for Classic off-chain. Quotes are computed using the balances
 * of the pools within each route provided.
 *
 * @export
 * @class ClassicQuoteProvider
 */
export class ClassicQuoteProvider implements IClassicQuoteProvider {
  /* eslint-disable @typescript-eslint/no-empty-function */
  constructor() {}

  /* eslint-enable @typescript-eslint/no-empty-function */

  public async getQuotesManyExactIn(
    amountIns: CurrencyAmount[],
    routes: ClassicRoute[],
    providerConfig: ProviderConfig
  ): Promise<{ routesWithQuotes: ClassicRouteWithQuotes[] }> {
    return this.getQuotes(
      amountIns,
      routes,
      TradeType.EXACT_INPUT,
      providerConfig
    );
  }

  public async getQuotesManyExactOut(
    amountOuts: CurrencyAmount[],
    routes: ClassicRoute[],
    providerConfig: ProviderConfig
  ): Promise<{ routesWithQuotes: ClassicRouteWithQuotes[] }> {
    return this.getQuotes(
      amountOuts,
      routes,
      TradeType.EXACT_OUTPUT,
      providerConfig
    );
  }

  private async getQuotes(
    amounts: CurrencyAmount[],
    routes: ClassicRoute[],
    tradeType: TradeType,
    providerConfig: ProviderConfig
  ): Promise<{ routesWithQuotes: ClassicRouteWithQuotes[] }> {
    const routesWithQuotes: ClassicRouteWithQuotes[] = [];

    const debugStrs: string[] = [];
    for (const route of routes) {
      const amountQuotes: ClassicAmountQuote[] = [];

      let insufficientInputAmountErrorCount = 0;
      let insufficientReservesErrorCount = 0;
      for (const amount of amounts) {
        try {
          if (tradeType == TradeType.EXACT_INPUT) {
            let outputAmount = amount.wrapped;

            for (const pair of route.pairs) {
              [outputAmount] = pair.getOutputAmount(
                outputAmount,
                providerConfig.enableFeeOnTransferFeeFetching === true
              );
            }

            amountQuotes.push({
              amount,
              quote: BigNumber.from(outputAmount.quotient.toString()),
            });
          } else {
            let inputAmount = amount.wrapped;

            for (let i = route.pairs.length - 1; i >= 0; i--) {
              const pair = route.pairs[i]!;
              [inputAmount] = pair.getInputAmount(
                inputAmount,
                providerConfig.enableFeeOnTransferFeeFetching === true
              );
            }

            amountQuotes.push({
              amount,
              quote: BigNumber.from(inputAmount.quotient.toString()),
            });
          }
        } catch (err) {
          // Can fail to get quotes, e.g. throws InsufficientReservesError or InsufficientInputAmountError.
          if (err instanceof InsufficientInputAmountError) {
            insufficientInputAmountErrorCount =
              insufficientInputAmountErrorCount + 1;
            amountQuotes.push({ amount, quote: null });
          } else if (err instanceof InsufficientReservesError) {
            insufficientReservesErrorCount = insufficientReservesErrorCount + 1;
            amountQuotes.push({ amount, quote: null });
          } else {
            throw err;
          }
        }
      }

      if (
        insufficientInputAmountErrorCount > 0 ||
        insufficientReservesErrorCount > 0
      ) {
        debugStrs.push(
          `${[
            routeToString(route),
          ]} Input: ${insufficientInputAmountErrorCount} Reserves: ${insufficientReservesErrorCount} }`
        );
      }

      routesWithQuotes.push([route, amountQuotes]);
    }

    if (debugStrs.length > 0) {
      log.info({ debugStrs }, `Failed quotes for Classic routes`);
    }

    return {
      routesWithQuotes,
    };
  }
}
