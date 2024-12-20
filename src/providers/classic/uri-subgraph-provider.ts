import { URISubgraphProvider } from '../uri-subgraph-provider';

import {
  ClassicSubgraphPool,
  IClassicSubgraphProvider,
} from './subgraph-provider';

export class ClassicURISubgraphProvider
  extends URISubgraphProvider<ClassicSubgraphPool>
  implements IClassicSubgraphProvider {}
