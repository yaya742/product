import { emptyRoute, type MapPoint, type MapRouteResult } from '../../shared/map-v2';
export interface SelectionState {
  mode: 'current' | 'two';
  stage: 'browse' | 'origin' | 'destination';
  origin?: MapPoint;
  destination?: MapPoint;
  route: MapRouteResult;
  revision: number;
}
export type SelectionAction =
  | { type: 'choose'; point: MapPoint }
  | { type: 'two' }
  | { type: 'origin' }
  | { type: 'destination' }
  | { type: 'swap' }
  | { type: 'clear' }
  | { type: 'current' }
  | { type: 'retry' }
  | { type: 'loading'; revision: number }
  | { type: 'result'; revision: number; route: MapRouteResult };
export const initialSelection: SelectionState = {
  mode: 'current',
  stage: 'browse',
  route: emptyRoute(),
  revision: 0,
};
export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  if (a.type === 'result') return a.revision === s.revision ? { ...s, route: a.route } : s;
  if (a.type === 'loading')
    return a.revision === s.revision
      ? { ...s, route: { ...emptyRoute(), status: 'loading', reason: '正在查找这两个地点之间的路线…' } }
      : s;
  const next = { ...s, revision: s.revision + 1, route: emptyRoute() };
  switch (a.type) {
    case 'choose':
      return s.stage === 'origin'
        ? { ...next, origin: a.point, stage: 'destination' }
        : { ...next, destination: a.point, stage: 'browse' };
    case 'two':
      return { ...next, mode: 'two', stage: 'origin', origin: undefined, destination: undefined };
    case 'origin':
      return { ...next, mode: 'two', stage: 'origin' };
    case 'destination':
      return { ...next, stage: 'destination' };
    case 'swap':
      return {
        ...next,
        mode: 'two',
        origin: s.destination,
        destination: s.origin,
        stage: !s.destination ? 'origin' : !s.origin ? 'destination' : 'browse',
      };
    case 'clear':
      return {
        ...initialSelection,
        mode: s.mode,
        stage: s.mode === 'two' ? 'origin' : 'browse',
        revision: next.revision,
      };
    case 'current':
      return { ...next, mode: 'current', origin: undefined, stage: 'browse' };
    case 'retry':
      return next;
  }
}
/** Every asynchronous camera suggestion carries the user's interaction generation. */
export class CameraOwnership {
  revision = 0;
  interacted = false;
  alive = true;
  take() {
    this.interacted = true;
    return ++this.revision;
  }
  ticket() {
    return this.revision;
  }
  accepts(ticket: number) {
    return this.alive && ticket === this.revision;
  }
  destroy() {
    this.alive = false;
    this.revision++;
  }
}
