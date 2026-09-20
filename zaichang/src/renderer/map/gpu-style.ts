import type { FlatStyleLike } from 'ol/style/flat';
import type { MapPalette } from './map-theme';
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1, 3), 16);
  return `rgba(${n},${n},${n},${a})`;
};
/** Flat 2D vector styles only. No height, depth, extrusion, terrain or lighting. */
export function planarGpuStyle(p: MapPalette, contrast = false): FlatStyleLike {
  const kind = (name: string) => ['==', ['get', 'kind'], name];
  const context = ['==', ['get', 'scope'], 'context'];
  const near = ['==', ['var', 'near'], 1],
    paths = ['==', ['var', 'paths'], 1];
  const major = [
    'in',
    ['get', 'highway'],
    [
      'literal',
      [
        'primary',
        'primary_link',
        'secondary',
        'secondary_link',
        'tertiary',
        'tertiary_link',
        'residential',
        'living_street',
      ],
    ],
  ];
  const path = ['in', ['get', 'highway'], ['literal', ['path', 'footway', 'pedestrian', 'steps']]];
  const roadFilter = ['all', kind('road'), ['any', ['!', path], paths]];
  const width = [
    '*',
    ['case', context, 0.8, 1],
    ['case', major, ['case', near, 2.8, 1.9], path, ['case', near, 1.05, 0.7], 1.2],
  ];
  const roadColor = [
    'case',
    major,
    ['case', context, alpha(p.road, 0.36), p.road],
    ['case', context, alpha(p.minorRoad, 0.36), p.minorRoad],
  ];
  return [
    { filter: kind('land'), style: { 'fill-color': alpha(p.land, 0.7) } },
    {
      filter: kind('area'),
      style: { 'stroke-color': alpha(p.outline, 0.23), 'stroke-width': 0.65, 'stroke-line-dash': [3, 5] },
    },
    {
      filter: kind('water'),
      style: { 'fill-color': p.water, 'stroke-color': alpha(p.outline, 0.42), 'stroke-width': 0.7 },
    },
    { filter: kind('waterway'), style: { 'stroke-color': p.water, 'stroke-width': ['case', near, 3.5, 2] } },
    {
      filter: kind('landmark'),
      style: {
        'fill-color': [255, 255, 255, 0.16],
        'stroke-color': p.selected,
        'stroke-width': 1.2,
        'stroke-line-dash': [3, 2],
      },
    },
    {
      filter: ['all', roadFilter, ['==', ['get', 'bridge'], 'yes']],
      style: { 'stroke-color': p.halo, 'stroke-width': ['+', width, 2.4] },
    },
    {
      filter: ['all', roadFilter, ['!=', ['get', 'tunnel'], 'yes'], ['!=', ['get', 'highway'], 'steps']],
      style: {
        'stroke-color': roadColor,
        'stroke-width': width,
        'stroke-line-cap': 'round',
        'stroke-line-join': 'round',
      },
    },
    {
      filter: ['all', roadFilter, ['==', ['get', 'tunnel'], 'yes']],
      style: { 'stroke-color': roadColor, 'stroke-width': width, 'stroke-line-dash': [3, 4] },
    },
    {
      filter: ['all', roadFilter, ['==', ['get', 'highway'], 'steps']],
      style: { 'stroke-color': roadColor, 'stroke-width': width, 'stroke-line-dash': [1, 2] },
    },
    {
      filter: kind('building'),
      style: {
        'fill-color': ['case', context, alpha(p.building, 0.7), p.building],
        'stroke-color': [
          'case',
          context,
          alpha(contrast ? p.text : p.outline, 0.65),
          contrast ? p.text : p.outline,
        ],
        'stroke-width': ['case', near, 0.85, 0.65],
      },
    },
    { filter: ['all', kind('barrier'), near], style: { 'stroke-color': p.barrier, 'stroke-width': 0.8 } },
  ] as FlatStyleLike;
}
