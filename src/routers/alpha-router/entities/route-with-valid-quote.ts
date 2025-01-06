import { Pool } from '@airdao/astra-cl-sdk';
import { Protocol } from '@airdao/astra-router-sdk';
import { Token, TradeType } from '@airdao/astra-sdk-core';
import { BigNumber } from '@ethersproject/bignumber';
import _ from 'lodash';

import { IClassicPoolProvider, ICLPoolProvider } from '../../../providers/';
import { CurrencyAmount, routeToString } from '../../../util';
import { ClassicRoute, CLRoute, MixedRoute } from '../../router';
import { IGasModel } from '../gas-models';

/**
 * Represents a route, a quote for swapping some amount on it, and other
 * metadata used by the routing algorithm.
 *
 * @export
 * @interface IRouteWithValidQuote
 * @template Route
 */
export interface IRouteWithValidQuote<
  Route extends CLRoute | ClassicRoute | MixedRoute
> {
  amount: CurrencyAmount;
  percent: number;
  // If exact in, this is (quote - gasCostInToken). If exact out, this is (quote + gasCostInToken).
  quoteAdjustedForGas: CurrencyAmount;
  quote: CurrencyAmount;
  route: Route;
  gasEstimate: BigNumber;
  // The gas cost in terms of the quote token.
  gasCostInToken: CurrencyAmount;
  gasCostInUSD: CurrencyAmount;
  tradeType: TradeType;
  poolAddresses: string[];
  tokenPath: Token[];
}

// Discriminated unions on protocol field to narrow types.
export type IClassicRouteWithValidQuote = {
  protocol: Protocol.Classic;
} & IRouteWithValidQuote<ClassicRoute>;

export type ICLRouteWithValidQuote = {
  protocol: Protocol.CL;
} & IRouteWithValidQuote<CLRoute>;

export type IMixedRouteWithValidQuote = {
  protocol: Protocol.MIXED;
} & IRouteWithValidQuote<MixedRoute>;

export type RouteWithValidQuote =
  | ClassicRouteWithValidQuote
  | CLRouteWithValidQuote
  | MixedRouteWithValidQuote;

export type ClassicRouteWithValidQuoteParams = {
  amount: CurrencyAmount;
  rawQuote: BigNumber;
  percent: number;
  route: ClassicRoute;
  gasModel: IGasModel<ClassicRouteWithValidQuote>;
  quoteToken: Token;
  tradeType: TradeType;
  classicPoolProvider: IClassicPoolProvider;
};

/**
 * Represents a quote for swapping on a Classic only route. Contains all information
 * such as the route used, the amount specified by the user, the type of quote
 * (exact in or exact out), the quote itself, and gas estimates.
 *
 * @export
 * @class ClassicRouteWithValidQuote
 */
export class ClassicRouteWithValidQuote implements IClassicRouteWithValidQuote {
  public readonly protocol = Protocol.Classic;
  public amount: CurrencyAmount;
  // The BigNumber representing the quote.
  public rawQuote: BigNumber;
  public quote: CurrencyAmount;
  public quoteAdjustedForGas: CurrencyAmount;
  public percent: number;
  public route: ClassicRoute;
  public quoteToken: Token;
  public gasModel: IGasModel<ClassicRouteWithValidQuote>;
  public gasEstimate: BigNumber;
  public gasCostInToken: CurrencyAmount;
  public gasCostInUSD: CurrencyAmount;
  public tradeType: TradeType;
  public poolAddresses: string[];
  public tokenPath: Token[];

  public toString(): string {
    return `${this.percent.toFixed(
      2
    )}% QuoteGasAdj[${this.quoteAdjustedForGas.toExact()}] Quote[${this.quote.toExact()}] Gas[${this.gasEstimate.toString()}] = ${routeToString(
      this.route
    )}`;
  }

  constructor({
    amount,
    rawQuote,
    percent,
    route,
    gasModel,
    quoteToken,
    tradeType,
    classicPoolProvider,
  }: ClassicRouteWithValidQuoteParams) {
    this.amount = amount;
    this.rawQuote = rawQuote;
    this.quote = CurrencyAmount.fromRawAmount(quoteToken, rawQuote.toString());
    this.percent = percent;
    this.route = route;
    this.gasModel = gasModel;
    this.quoteToken = quoteToken;
    this.tradeType = tradeType;

    const { gasEstimate, gasCostInToken, gasCostInUSD } =
      this.gasModel.estimateGasCost(this);

    this.gasCostInToken = gasCostInToken;
    this.gasCostInUSD = gasCostInUSD;
    this.gasEstimate = gasEstimate;

    // If its exact out, we need to request *more* of the input token to account for the gas.
    if (this.tradeType == TradeType.EXACT_INPUT) {
      const quoteGasAdjusted = this.quote.subtract(gasCostInToken);
      this.quoteAdjustedForGas = quoteGasAdjusted;
    } else {
      const quoteGasAdjusted = this.quote.add(gasCostInToken);
      this.quoteAdjustedForGas = quoteGasAdjusted;
    }

    this.poolAddresses = _.map(
      route.pairs,
      (p) => classicPoolProvider.getPoolAddress(p.token0, p.token1).poolAddress
    );

    this.tokenPath = this.route.path;
  }
}

export type CLRouteWithValidQuoteParams = {
  amount: CurrencyAmount;
  rawQuote: BigNumber;
  sqrtPriceX96AfterList: BigNumber[];
  initializedTicksCrossedList: number[];
  quoterGasEstimate: BigNumber;
  percent: number;
  route: CLRoute;
  gasModel: IGasModel<CLRouteWithValidQuote>;
  quoteToken: Token;
  tradeType: TradeType;
  clPoolProvider: ICLPoolProvider;
};

/**
 * Represents a quote for swapping on a CL only route. Contains all information
 * such as the route used, the amount specified by the user, the type of quote
 * (exact in or exact out), the quote itself, and gas estimates.
 *
 * @export
 * @class CLRouteWithValidQuote
 */
export class CLRouteWithValidQuote implements ICLRouteWithValidQuote {
  public readonly protocol = Protocol.CL;
  public amount: CurrencyAmount;
  public rawQuote: BigNumber;
  public quote: CurrencyAmount;
  public quoteAdjustedForGas: CurrencyAmount;
  public sqrtPriceX96AfterList: BigNumber[];
  public initializedTicksCrossedList: number[];
  public quoterGasEstimate: BigNumber;
  public percent: number;
  public route: CLRoute;
  public quoteToken: Token;
  public gasModel: IGasModel<CLRouteWithValidQuote>;
  public gasEstimate: BigNumber;
  public gasCostInToken: CurrencyAmount;
  public gasCostInUSD: CurrencyAmount;
  public tradeType: TradeType;
  public poolAddresses: string[];
  public tokenPath: Token[];

  public toString(): string {
    return `${this.percent.toFixed(
      2
    )}% QuoteGasAdj[${this.quoteAdjustedForGas.toExact()}] Quote[${this.quote.toExact()}] Gas[${this.gasEstimate.toString()}] = ${routeToString(
      this.route
    )}`;
  }

  constructor({
    amount,
    rawQuote,
    sqrtPriceX96AfterList,
    initializedTicksCrossedList,
    quoterGasEstimate,
    percent,
    route,
    gasModel,
    quoteToken,
    tradeType,
    clPoolProvider,
  }: CLRouteWithValidQuoteParams) {
    this.amount = amount;
    this.rawQuote = rawQuote;
    this.sqrtPriceX96AfterList = sqrtPriceX96AfterList;
    this.initializedTicksCrossedList = initializedTicksCrossedList;
    this.quoterGasEstimate = quoterGasEstimate;
    this.quote = CurrencyAmount.fromRawAmount(quoteToken, rawQuote.toString());
    this.percent = percent;
    this.route = route;
    this.gasModel = gasModel;
    this.quoteToken = quoteToken;
    this.tradeType = tradeType;

    const { gasEstimate, gasCostInToken, gasCostInUSD } =
      this.gasModel.estimateGasCost(this);

    this.gasCostInToken = gasCostInToken;
    this.gasCostInUSD = gasCostInUSD;
    this.gasEstimate = gasEstimate;

    // If It's exact out, we need to request *more* of the input token to account for the gas.
    if (this.tradeType == TradeType.EXACT_INPUT) {
      this.quoteAdjustedForGas = this.quote.subtract(gasCostInToken);
    } else {
      this.quoteAdjustedForGas = this.quote.add(gasCostInToken);
    }

    this.poolAddresses = _.map(
      route.pools,
      (p) =>
        clPoolProvider.getPoolAddress(p.token0, p.token1, p.fee).poolAddress
    );

    this.tokenPath = this.route.tokenPath;
  }
}

export type MixedRouteWithValidQuoteParams = {
  amount: CurrencyAmount;
  rawQuote: BigNumber;
  sqrtPriceX96AfterList: BigNumber[];
  initializedTicksCrossedList: number[];
  quoterGasEstimate: BigNumber;
  percent: number;
  route: MixedRoute;
  mixedRouteGasModel: IGasModel<MixedRouteWithValidQuote>;
  quoteToken: Token;
  tradeType: TradeType;
  clPoolProvider: ICLPoolProvider;
  classicPoolProvider: IClassicPoolProvider;
};

/**
 * Represents a quote for swapping on a Mixed Route. Contains all information
 * such as the route used, the amount specified by the user, the type of quote
 * (exact in or exact out), the quote itself, and gas estimates.
 *
 * @export
 * @class MixedRouteWithValidQuote
 */
export class MixedRouteWithValidQuote implements IMixedRouteWithValidQuote {
  public readonly protocol = Protocol.MIXED;
  public amount: CurrencyAmount;
  public rawQuote: BigNumber;
  public quote: CurrencyAmount;
  public quoteAdjustedForGas: CurrencyAmount;
  public sqrtPriceX96AfterList: BigNumber[];
  public initializedTicksCrossedList: number[];
  public quoterGasEstimate: BigNumber;
  public percent: number;
  public route: MixedRoute;
  public quoteToken: Token;
  public gasModel: IGasModel<MixedRouteWithValidQuote>;
  public gasEstimate: BigNumber;
  public gasCostInToken: CurrencyAmount;
  public gasCostInUSD: CurrencyAmount;
  public tradeType: TradeType;
  public poolAddresses: string[];
  public tokenPath: Token[];

  public toString(): string {
    return `${this.percent.toFixed(
      2
    )}% QuoteGasAdj[${this.quoteAdjustedForGas.toExact()}] Quote[${this.quote.toExact()}] Gas[${this.gasEstimate.toString()}] = ${routeToString(
      this.route
    )}`;
  }

  constructor({
    amount,
    rawQuote,
    sqrtPriceX96AfterList,
    initializedTicksCrossedList,
    quoterGasEstimate,
    percent,
    route,
    mixedRouteGasModel,
    quoteToken,
    tradeType,
    clPoolProvider,
    classicPoolProvider,
  }: MixedRouteWithValidQuoteParams) {
    this.amount = amount;
    this.rawQuote = rawQuote;
    this.sqrtPriceX96AfterList = sqrtPriceX96AfterList;
    this.initializedTicksCrossedList = initializedTicksCrossedList;
    this.quoterGasEstimate = quoterGasEstimate;
    this.quote = CurrencyAmount.fromRawAmount(quoteToken, rawQuote.toString());
    this.percent = percent;
    this.route = route;
    this.gasModel = mixedRouteGasModel;
    this.quoteToken = quoteToken;
    this.tradeType = tradeType;

    const { gasEstimate, gasCostInToken, gasCostInUSD } =
      this.gasModel.estimateGasCost(this);

    this.gasCostInToken = gasCostInToken;
    this.gasCostInUSD = gasCostInUSD;
    this.gasEstimate = gasEstimate;

    // If its exact out, we need to request *more* of the input token to account for the gas.
    if (this.tradeType == TradeType.EXACT_INPUT) {
      const quoteGasAdjusted = this.quote.subtract(gasCostInToken);
      this.quoteAdjustedForGas = quoteGasAdjusted;
    } else {
      const quoteGasAdjusted = this.quote.add(gasCostInToken);
      this.quoteAdjustedForGas = quoteGasAdjusted;
    }

    this.poolAddresses = _.map(route.pools, (p) => {
      return p instanceof Pool
        ? clPoolProvider.getPoolAddress(p.token0, p.token1, p.fee).poolAddress
        : classicPoolProvider.getPoolAddress(p.token0, p.token1).poolAddress;
    });

    this.tokenPath = this.route.path.map((currency) => currency as Token);
  }
}
