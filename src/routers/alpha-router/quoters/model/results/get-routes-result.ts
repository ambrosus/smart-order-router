import { ClassicRoute, CLRoute, MixedRoute } from '../../../../router';
import { CandidatePoolsBySelectionCriteria } from '../../../functions/get-candidate-pools';

export interface GetRoutesResult<
  Route extends ClassicRoute | CLRoute | MixedRoute
> {
  routes: Route[];
  candidatePools: CandidatePoolsBySelectionCriteria;
}
