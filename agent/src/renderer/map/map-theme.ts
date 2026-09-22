// All controlled map primitives are neutral gray. The canvas itself stays transparent.
export const darkMapPalette = {
  water: '#202020',
  land: '#1c1c1c',
  building: '#353535',
  outline: '#696969',
  road: '#838383',
  minorRoad: '#575757',
  text: '#eeeeee',
  secondaryText: '#bdbdbd',
  halo: '#242424',
  hover: '#888888',
  selected: '#dedede',
  route: '#ffffff',
  location: '#ffffff',
  barrier: '#585858',
};
export const lightMapPalette = {
  water: '#e1e1e1',
  land: '#eeeeee',
  building: '#d6d6d6',
  outline: '#969696',
  road: '#707070',
  minorRoad: '#acacac',
  text: '#252525',
  secondaryText: '#505050',
  halo: '#f3f3f3',
  hover: '#6a6a6a',
  selected: '#3a3a3a',
  route: '#171717',
  location: '#171717',
  barrier: '#999999',
};
export type MapPalette = typeof darkMapPalette;
export function neutralPalette(p: MapPalette) {
  return Object.values(p).every((c) => /^#([a-f\d]{2})\1\1$/i.test(c));
}
