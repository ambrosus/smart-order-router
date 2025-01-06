import { Protocol } from '@airdao/astra-router-sdk';
import { ChainId, Currency, Token, TradeType } from '@airdao/astra-sdk-core';
import _ from 'lodash';

import {
  ICLPoolProvider,
  ICLSubgraphProvider,
  IOnChainQuoteProvider,
  ITokenListProvider,
  ITokenProvider,
  ITokenValidatorProvider,
  TokenValidationResult,
} from '../../../providers';
import {
  CurrencyAmount,
  log,
  metric,
  MetricLoggerUnit,
  routeToString,
} from '../../../util';
import { CLRoute } from '../../router';
import { AlphaRouterConfig } from '../alpha-router';
import { CLRouteWithValidQuote } from '../entities';
import { computeAllCLRoutes } from '../functions/compute-all-routes';
import {
  CandidatePoolsBySelectionCriteria,
  CLCandidatePools,
} from '../functions/get-candidate-pools';
import { IGasModel } from '../gas-models';

import { BaseQuoter } from './base-quoter';
import { GetQuotesResult, GetRoutesResult } from './model';

export class CLQuoter extends BaseQuoter<CLCandidatePools, CLRoute> {
  protected clSubgraphProvider: ICLSubgraphProvider;
  protected clPoolProvider: ICLPoolProvider;
  protected onChainQuoteProvider: IOnChainQuoteProvider;

  constructor(
    clSubgraphProvider: ICLSubgraphProvider,
    clPoolProvider: ICLPoolProvider,
    onChainQuoteProvider: IOnChainQuoteProvider,
    tokenProvider: ITokenProvider,
    chainId: ChainId,
    blockedTokenListProvider?: ITokenListProvider,
    tokenValidatorProvider?: ITokenValidatorProvider
  ) {
    super(
      tokenProvider,
      chainId,
      Protocol.CL,
      blockedTokenListProvider,
      tokenValidatorProvider
    );
    this.clSubgraphProvider = clSubgraphProvider;
    this.clPoolProvider = clPoolProvider;
    this.onChainQuoteProvider = onChainQuoteProvider;
  }

  protected async getRoutes(
    tokenIn: Token,
    tokenOut: Token,
    clCandidatePools: CLCandidatePools,
    _tradeType: TradeType,
    routingConfig: AlphaRouterConfig
  ): Promise<GetRoutesResult<CLRoute>> {
    const beforeGetRoutes = Date.now();
    // Fetch all the pools that we will consider routing via. There are thousands
    // of pools, so we filter them to a set of candidate pools that we expect will
    // result in good prices.
    const { poolAccessor, candidatePools } = clCandidatePools;
    const poolsRaw = poolAccessor.getAllPools();

    // Drop any pools that contain fee on transfer tokens (not supported by CL) or have issues with being transferred.
    const pools = await this.applyTokenValidatorToPools(
      poolsRaw,
      (
        token: Currency,
        tokenValidation: TokenValidationResult | undefined
      ): boolean => {
        // If there is no available validation result we assume the token is fine.
        if (!tokenValidation) {
          return false;
        }

        // Only filters out *intermediate* pools that involve tokens that we detect
        // cant be transferred. This prevents us trying to route through tokens that may
        // not be transferrable, but allows users to still swap those tokens if they
        // specify.
        //
        if (
          tokenValidation == TokenValidationResult.STF &&
          (token.equals(tokenIn) || token.equals(tokenOut))
        ) {
          return false;
        }

        return (
          tokenValidation == TokenValidationResult.FOT ||
          tokenValidation == TokenValidationResult.STF
        );
      }
    );

    // Given all our candidate pools, compute all the possible ways to route from tokenIn to tokenOut.
    const { maxSwapsPerPath } = routingConfig;
    const routes = computeAllCLRoutes(
      tokenIn,
      tokenOut,
      pools,
      maxSwapsPerPath
    );

    metric.putMetric(
      'CLGetRoutesLoad',
      Date.now() - beforeGetRoutes,
      MetricLoggerUnit.Milliseconds
    );

    return {
      routes,
      candidatePools,
    };
  }

  public async getQuotes(
    routes: CLRoute[],
    amounts: CurrencyAmount[],
    percents: number[],
    quoteToken: Token,
    tradeType: TradeType,
    routingConfig: AlphaRouterConfig,
    candidatePools?: CandidatePoolsBySelectionCriteria,
    gasModel?: IGasModel<CLRouteWithValidQuote>
  ): Promise<GetQuotesResult> {
    const beforeGetQuotes = Date.now();
    log.info('Starting to get CL quotes');

    if (gasModel === undefined) {
      throw new Error(
        'GasModel for CLRouteWithValidQuote is required to getQuotes'
      );
    }

    if (routes.length == 0) {
      return { routesWithValidQuotes: [], candidatePools };
    }

    // For all our routes, and all the fractional amounts, fetch quotes on-chain.
    const quoteFn =
      tradeType == TradeType.EXACT_INPUT
        ? this.onChainQuoteProvider.getQuotesManyExactIn.bind(
            this.onChainQuoteProvider
          )
        : this.onChainQuoteProvider.getQuotesManyExactOut.bind(
            this.onChainQuoteProvider
          );

    const beforeQuotes = Date.now();
    log.info(
      `Getting quotes for CL for ${routes.length} routes with ${amounts.length} amounts per route.`
    );

    const { routesWithQuotes } = await quoteFn<CLRoute>(amounts, routes, {
      blockNumber: routingConfig.blockNumber,
    });

    metric.putMetric(
      'CLQuotesLoad',
      Date.now() - beforeQuotes,
      MetricLoggerUnit.Milliseconds
    );

    metric.putMetric(
      'CLQuotesFetched',
      _(routesWithQuotes)
        .map(([, quotes]) => quotes.length)
        .sum(),
      MetricLoggerUnit.Count
    );

    const routesWithValidQuotes = [];

    for (const routeWithQuote of routesWithQuotes) {
      const [route, quotes] = routeWithQuote;

      for (let i = 0; i < quotes.length; i++) {
        const percent = percents[i]!;
        const amountQuote = quotes[i]!;
        const {
          quote,
          amount,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          gasEstimate,
        } = amountQuote;

        if (
          !quote ||
          !sqrtPriceX96AfterList ||
          !initializedTicksCrossedList ||
          !gasEstimate
        ) {
          log.debug(
            {
              route: routeToString(route),
              amountQuote,
            },
            'Dropping a null CL quote for route.'
          );
          continue;
        }

        const routeWithValidQuote = new CLRouteWithValidQuote({
          route,
          rawQuote: quote,
          amount,
          percent,
          sqrtPriceX96AfterList,
          initializedTicksCrossedList,
          quoterGasEstimate: gasEstimate,
          gasModel,
          quoteToken,
          tradeType,
          clPoolProvider: this.clPoolProvider,
        });

        routesWithValidQuotes.push(routeWithValidQuote);
      }
    }

    metric.putMetric(
      'CLGetQuotesLoad',
      Date.now() - beforeGetQuotes,
      MetricLoggerUnit.Milliseconds
    );

    return {
      routesWithValidQuotes,
      candidatePools,
    };
  }
}
