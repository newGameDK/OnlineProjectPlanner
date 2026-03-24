'use strict';

// ==========================================================================
// Color Utilities – pure functions, no external dependencies
// ==========================================================================

// Default palette shown in the base-color picker.
const BASE_COLORS = [
  '#2196F3','#4CAF50','#FF9800','#9C27B0','#F44336',
  '#009688','#E91E63','#3F51B5','#795548','#00BCD4'
];

/**
 * Generate 10 rainbow-like color variations from a base color.
 * Hues are spread evenly around the color wheel, starting from the
 * base color's hue, with consistent saturation and lightness for a
 * cohesive, vibrant theme.  Sub-task colors are derived separately
 * by the gantt module (lighter versions of the parent).
 */
function generateColorVariations(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s] = rgbToHsl(r, g, b);
  const baseSat = Math.max(0.6, Math.min(0.8, s || 0.65));
  const baseLit = 0.5;
  const vars = [];
  for (let i = 0; i < 10; i++) {
    const hue = (h + i / 10) % 1.0;
    vars.push(hslToHex(hue, baseSat, baseLit));
  }
  return vars;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#',''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      default: h = ((r-g)/d + 4)/6;
    }
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p,q,t) => {
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6)return p+(q-p)*6*t;
      if(t<1/2)return q;
      if(t<2/3)return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return '#' + [r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

/**
 * Returns true if the given hex color is "dark" (relative luminance < 0.45).
 * Uses ITU-R BT.601 luma coefficients for perceived brightness.
 */
function isColorDark(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.45;
}

/**
 * Return a lighter version of a hex color by increasing HSL lightness.
 * @param {string} hex   - Input color e.g. '#2196F3'
 * @param {number} amount - How much to add to lightness (0–1 range)
 */
function lightenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, s, Math.min(0.92, l + amount));
}

/**
 * Return a darker version of a hex color by decreasing HSL lightness.
 * @param {string} hex   - Input color e.g. '#4CAF50'
 * @param {number} amount - How much to subtract from lightness (0–1 range)
 */
function darkenColor(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, s, Math.max(0, l - amount));
}
