import { Pool } from '@airdao/astra-cl-sdk';
import { Protocol } from '@airdao/astra-router-sdk';
import { Token } from '@airdao/astra-sdk-core';

import { ClassicRoute, CLRoute, MixedRoute } from '../../../../routers';

interface CachedRouteParams<Route extends CLRoute | ClassicRoute | MixedRoute> {
  route: Route;
  percent: number;
}

/**
 * Class defining the route to cache
 *
 * @export
 * @class CachedRoute
 */
export class CachedRoute<Route extends CLRoute | ClassicRoute | MixedRoute> {
  public readonly route: Route;
  public readonly percent: number;
  // Hashing function copying the same implementation as Java's `hashCode`
  // Sourced from: https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0?permalink_comment_id=4613539#gistcomment-4613539
  private hashCode = (str: string) =>
    [...str].reduce((s, c) => (Math.imul(31, s) + c.charCodeAt(0)) | 0, 0);

  /**
   * @param route
   * @param percent
   */
  constructor({ route, percent }: CachedRouteParams<Route>) {
    this.route = route;
    this.percent = percent;
  }

  public get protocol(): Protocol {
    return this.route.protocol;
  }

  public get tokenIn(): Token {
    return this.route.input;
  }

  public get tokenOut(): Token {
    return this.route.output;
  }

  public get routePath(): string {
    if (this.protocol == Protocol.CL) {
      const route = this.route as CLRoute;
      return route.pools
        .map(
          (pool) =>
            `[CL]${pool.token0.address}/${pool.token1.address}/${pool.fee}`
        )
        .join('->');
    } else if (this.protocol == Protocol.Classic) {
      const route = this.route as ClassicRoute;
      return route.pairs
        .map((pair) => `[Classic]${pair.token0.address}/${pair.token1.address}`)
        .join('->');
    } else {
      const route = this.route as MixedRoute;
      return route.pools
        .map((pool) => {
          if (pool instanceof Pool) {
            return `[CL]${pool.token0.address}/${pool.token1.address}/${pool.fee}`;
          } else {
            return `[Classic]${pool.token0.address}/${pool.token1.address}`;
          }
        })
        .join('->');
    }
  }

  public get routeId(): number {
    return this.hashCode(this.routePath);
  }
}
