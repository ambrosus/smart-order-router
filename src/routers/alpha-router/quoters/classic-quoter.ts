import { Protocol } from '@airdao/astra-router-sdk';
import { ChainId, Currency, Token, TradeType } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import _ from 'lodash';

import {
  IClassicPoolProvider,
  IClassicQuoteProvider,
  IClassicSubgraphProvider,
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
import { ClassicRoute } from '../../router';
import { AlphaRouterConfig } from '../alpha-router';
import { ClassicRouteWithValidQuote } from '../entities';
import { computeAllClassicRoutes } from '../functions/compute-all-routes';
import {
  CandidatePoolsBySelectionCriteria,
  ClassicCandidatePools,
} from '../functions/get-candidate-pools';
import { IClassicGasModelFactory, IGasModel } from '../gas-models';
import { NATIVE_OVERHEAD } from '../gas-models/cl/gas-costs';

import { BaseQuoter } from './base-quoter';
import { GetQuotesResult, GetRoutesResult } from './model';

export class ClassicQuoter extends BaseQuoter<
  ClassicCandidatePools,
  ClassicRoute
> {
  protected classicSubgraphProvider: IClassicSubgraphProvider;
  protected classicPoolProvider: IClassicPoolProvider;
  protected classicQuoteProvider: IClassicQuoteProvider;
  protected classicGasModelFactory: IClassicGasModelFactory;

  constructor(
    classicSubgraphProvider: IClassicSubgraphProvider,
    classicPoolProvider: IClassicPoolProvider,
    classicQuoteProvider: IClassicQuoteProvider,
    classicGasModelFactory: IClassicGasModelFactory,
    tokenProvider: ITokenProvider,
    chainId: ChainId,
    blockedTokenListProvider?: ITokenListProvider,
    tokenValidatorProvider?: ITokenValidatorProvider
  ) {
    super(
      tokenProvider,
      chainId,
      Protocol.Classic,
      blockedTokenListProvider,
      tokenValidatorProvider
    );
    this.classicSubgraphProvider = classicSubgraphProvider;
    this.classicPoolProvider = classicPoolProvider;
    this.classicQuoteProvider = classicQuoteProvider;
    this.classicGasModelFactory = classicGasModelFactory;
  }

  protected async getRoutes(
    tokenIn: Token,
    tokenOut: Token,
    classicCandidatePools: ClassicCandidatePools,
    _tradeType: TradeType,
    routingConfig: AlphaRouterConfig
  ): Promise<GetRoutesResult<ClassicRoute>> {
    const beforeGetRoutes = Date.now();
    // Fetch all the pools that we will consider routing via. There are thousands
    // of pools, so we filter them to a set of candidate pools that we expect will
    // result in good prices.
    const { poolAccessor, candidatePools } = classicCandidatePools;
    const poolsRaw = poolAccessor.getAllPools();

    // Drop any pools that contain tokens that can not be transferred according to the token validator.
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
        if (
          tokenValidation == TokenValidationResult.STF &&
          (token.equals(tokenIn) || token.equals(tokenOut))
        ) {
          return false;
        }

        return tokenValidation == TokenValidationResult.STF;
      }
    );

    // Given all our candidate pools, compute all the possible ways to route from tokenIn to tokenOut.
    const { maxSwapsPerPath } = routingConfig;
    const routes = computeAllClassicRoutes(
      tokenIn,
      tokenOut,
      pools,
      maxSwapsPerPath
    );

    metric.putMetric(
      'ClassicGetRoutesLoad',
      Date.now() - beforeGetRoutes,
      MetricLoggerUnit.Milliseconds
    );

    return {
      routes,
      candidatePools,
    };
  }

  public async getQuotes(
    routes: ClassicRoute[],
    amounts: CurrencyAmount[],
    percents: number[],
    quoteToken: Token,
    tradeType: TradeType,
    _routingConfig: AlphaRouterConfig,
    candidatePools?: CandidatePoolsBySelectionCriteria,
    _gasModel?: IGasModel<ClassicRouteWithValidQuote>,
    gasPriceWei?: BigNumber
  ): Promise<GetQuotesResult> {
    const beforeGetQuotes = Date.now();
    log.info('Starting to get Classic quotes');
    if (gasPriceWei === undefined) {
      throw new Error('GasPriceWei for ClassicRoutes is required to getQuotes');
    }
    // throw if we have no amounts or if there are different tokens in the amounts
    if (
      amounts.length == 0 ||
      !amounts.every((amount) => amount.currency.equals(amounts[0]!.currency))
    ) {
      throw new Error(
        'Amounts must have at least one amount and must be same token'
      );
    }
    // safe to force unwrap here because we throw if there are no amounts
    const amountToken = amounts[0]!.currency;

    if (routes.length == 0) {
      return { routesWithValidQuotes: [], candidatePools };
    }

    // For all our routes, and all the fractional amounts, fetch quotes on-chain.
    const quoteFn =
      tradeType == TradeType.EXACT_INPUT
        ? this.classicQuoteProvider.getQuotesManyExactIn.bind(
            this.classicQuoteProvider
          )
        : this.classicQuoteProvider.getQuotesManyExactOut.bind(
            this.classicQuoteProvider
          );

    const beforeQuotes = Date.now();

    log.info(
      `Getting quotes for Classic for ${routes.length} routes with ${amounts.length} amounts per route.`
    );
    const { routesWithQuotes } = await quoteFn(amounts, routes, _routingConfig);

    const classicGasModel = await this.classicGasModelFactory.buildGasModel({
      chainId: this.chainId,
      gasPriceWei,
      poolProvider: this.classicPoolProvider,
      token: quoteToken,
      providerConfig: {
        ..._routingConfig,
        additionalGasOverhead: NATIVE_OVERHEAD(
          this.chainId,
          amountToken,
          quoteToken
        ),
      },
    });

    metric.putMetric(
      'ClassicQuotesLoad',
      Date.now() - beforeQuotes,
      MetricLoggerUnit.Milliseconds
    );

    metric.putMetric(
      'ClassicQuotesFetched',
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
        const { quote, amount } = amountQuote;

        if (!quote) {
          log.debug(
            {
              route: routeToString(route),
              amountQuote,
            },
            'Dropping a null Classic quote for route.'
          );
          continue;
        }

        const routeWithValidQuote = new ClassicRouteWithValidQuote({
          route,
          rawQuote: quote,
          amount,
          percent,
          gasModel: classicGasModel,
          quoteToken,
          tradeType,
          classicPoolProvider: this.classicPoolProvider,
        });

        routesWithValidQuotes.push(routeWithValidQuote);
      }
    }

    metric.putMetric(
      'ClassicGetQuotesLoad',
      Date.now() - beforeGetQuotes,
      MetricLoggerUnit.Milliseconds
    );

    return {
      routesWithValidQuotes,
      candidatePools,
    };
  }

  public async refreshRoutesThenGetQuotes(
    tokenIn: Token,
    tokenOut: Token,
    routes: ClassicRoute[],
    amounts: CurrencyAmount[],
    percents: number[],
    quoteToken: Token,
    tradeType: TradeType,
    routingConfig: AlphaRouterConfig,
    gasPriceWei?: BigNumber
  ): Promise<GetQuotesResult> {
    const tokenPairs: [Token, Token][] = [];
    routes.forEach((route) =>
      route.pairs.forEach((pair) => tokenPairs.push([pair.token0, pair.token1]))
    );

    return this.classicPoolProvider
      .getPools(tokenPairs, routingConfig)
      .then((poolAccesor) => {
        const routes = computeAllClassicRoutes(
          tokenIn,
          tokenOut,
          poolAccesor.getAllPools(),
          routingConfig.maxSwapsPerPath
        );

        return this.getQuotes(
          routes,
          amounts,
          percents,
          quoteToken,
          tradeType,
          routingConfig,
          undefined,
          undefined,
          gasPriceWei
        );
      });
  }
}
