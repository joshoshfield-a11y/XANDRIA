/** Blueprint registry — genre → build function. */
import type { GameSpec, Genre } from '@spec';
import type { Engine } from '../engine/Engine';
import { buildThirdPersonAction } from './tpAction';
import { buildFpsArena } from './fpsArena';
import { buildRacing } from './racing';
import { buildPlatformer } from './platformer';
import { buildTopDown } from './topdown';

export type BlueprintFn = (engine: Engine, spec: GameSpec) => unknown;

export const BLUEPRINTS: Record<Genre, BlueprintFn> = {
  'third-person-action': buildThirdPersonAction,
  'fps-arena': buildFpsArena,
  racing: buildRacing,
  platformer: buildPlatformer,
  'top-down-shooter': buildTopDown,
};

export const GENRE_LABELS: Record<Genre, string> = {
  'third-person-action': 'Third-Person Action',
  'fps-arena': 'FPS Arena',
  racing: 'Racing',
  platformer: 'Platformer',
  'top-down-shooter': 'Top-Down Shooter',
};
