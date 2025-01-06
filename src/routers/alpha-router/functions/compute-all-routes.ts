import { Pool } from '@airdao/astra-cl-sdk';
import { Pair } from '@airdao/astra-classic-sdk';
import { Token } from '@airdao/astra-sdk-core';

import { log, poolToString, routeToString } from '../../../util';
import { ClassicRoute, CLRoute, MixedRoute } from '../../router';

export function computeAllCLRoutes(
  tokenIn: Token,
  tokenOut: Token,
  pools: Pool[],
  maxHops: number
): CLRoute[] {
  return computeAllRoutes<Pool, CLRoute>(
    tokenIn,
    tokenOut,
    (route: Pool[], tokenIn: Token, tokenOut: Token) => {
      return new CLRoute(route, tokenIn, tokenOut);
    },
    pools,
    maxHops
  );
}

export function computeAllClassicRoutes(
  tokenIn: Token,
  tokenOut: Token,
  pools: Pair[],
  maxHops: number
): ClassicRoute[] {
  return computeAllRoutes<Pair, ClassicRoute>(
    tokenIn,
    tokenOut,
    (route: Pair[], tokenIn: Token, tokenOut: Token) => {
      return new ClassicRoute(route, tokenIn, tokenOut);
    },
    pools,
    maxHops
  );
}

export function computeAllMixedRoutes(
  tokenIn: Token,
  tokenOut: Token,
  parts: (Pool | Pair)[],
  maxHops: number
): MixedRoute[] {
  const routesRaw = computeAllRoutes<Pool | Pair, MixedRoute>(
    tokenIn,
    tokenOut,
    (route: (Pool | Pair)[], tokenIn: Token, tokenOut: Token) => {
      return new MixedRoute(route, tokenIn, tokenOut);
    },
    parts,
    maxHops
  );
  /// filter out pure CL and Classic routes
  return routesRaw.filter((route) => {
    return (
      !route.pools.every((pool) => pool instanceof Pool) &&
      !route.pools.every((pool) => pool instanceof Pair)
    );
  });
}

export function computeAllRoutes<
  TPool extends Pair | Pool,
  TRoute extends CLRoute | ClassicRoute | MixedRoute
>(
  tokenIn: Token,
  tokenOut: Token,
  buildRoute: (route: TPool[], tokenIn: Token, tokenOut: Token) => TRoute,
  pools: TPool[],
  maxHops: number
): TRoute[] {
  const poolsUsed = Array<boolean>(pools.length).fill(false);
  const routes: TRoute[] = [];

  const computeRoutes = (
    tokenIn: Token,
    tokenOut: Token,
    currentRoute: TPool[],
    poolsUsed: boolean[],
    tokensVisited: Set<string>,
    _previousTokenOut?: Token
  ) => {
    if (currentRoute.length > maxHops) {
      return;
    }

    if (
      currentRoute.length > 0 &&
      currentRoute[currentRoute.length - 1]!.involvesToken(tokenOut)
    ) {
      routes.push(buildRoute([...currentRoute], tokenIn, tokenOut));
      return;
    }

    for (let i = 0; i < pools.length; i++) {
      if (poolsUsed[i]) {
        continue;
      }

      const curPool = pools[i]!;
      const previousTokenOut = _previousTokenOut ? _previousTokenOut : tokenIn;

      if (!curPool.involvesToken(previousTokenOut)) {
        continue;
      }

      const currentTokenOut = curPool.token0.equals(previousTokenOut)
        ? curPool.token1
        : curPool.token0;

      if (tokensVisited.has(currentTokenOut.address.toLowerCase())) {
        continue;
      }

      tokensVisited.add(currentTokenOut.address.toLowerCase());
      currentRoute.push(curPool);
      poolsUsed[i] = true;
      computeRoutes(
        tokenIn,
        tokenOut,
        currentRoute,
        poolsUsed,
        tokensVisited,
        currentTokenOut
      );
      poolsUsed[i] = false;
      currentRoute.pop();
      tokensVisited.delete(currentTokenOut.address.toLowerCase());
    }
  };

  computeRoutes(
    tokenIn,
    tokenOut,
    [],
    poolsUsed,
    new Set([tokenIn.address.toLowerCase()])
  );

  log.info(
    {
      routes: routes.map(routeToString),
      pools: pools.map(poolToString),
    },
    `Computed ${routes.length} possible routes for type ${routes[0]?.protocol}.`
  );

  return routes;
}
