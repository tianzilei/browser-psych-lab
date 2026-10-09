export const BACKGROUNDS = { gray: '#e5e5e5', dark: '#202020' } as const;

// Apply once before mounting a page or measuring a group. The frozen protocol
// supplies the exact color; system preferences never change an ongoing study.
export function applyParticipantBackground(background: string) {
  const rgb = background.slice(1).match(/../g)!.map(hex => {
    const channel = parseInt(hex, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
  const dark = luminance < .179;
  const root = document.documentElement;
  root.style.backgroundColor = background;
  root.style.color = dark ? '#ffffff' : '#000000';
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.setProperty('--background',background);root.style.setProperty('--foreground',dark?'#ffffff':'#000000');root.style.setProperty('--line',dark?'#606060':'#b4b4b4');
  root.dataset.theme = dark ? 'dark' : 'gray';
}
