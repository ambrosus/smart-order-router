import { URISubgraphProvider } from '../uri-subgraph-provider';

import { CLSubgraphPool, ICLSubgraphProvider } from './subgraph-provider';

export class CLURISubgraphProvider
  extends URISubgraphProvider<CLSubgraphPool>
  implements ICLSubgraphProvider {}
