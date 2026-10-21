// README badges: /owner/repo/badge.svg links a repo's README to its city. Three looks:
//   flat (default)  — shields-style, sits in a row with the usual build/npm/license badges
//   pixel           — the site's own pixel panel: paper, ink edge, offset shadow
//   card            — a little info card: the city, what it's built like, how many buildings
import { ICON } from './icon.js';

// each city type gets its own colour, so different repos' badges differ (all dark enough for white text)
const KIND_COLOR = {
  tokyo: '#c0413b', hongkong: '#7a2a35', manhattan: '#2f6188', la: '#c8682a', paris: '#8c4a3c', venice: '#2f7aa8',
  barcelona: '#b0603f', port: '#1f3d5a', university: '#5a4e8c', mountain: '#3d6b36', capital: '#4a4458',
  desert: '#8a7a4e', farm: '#4f7f3a', smalltown: '#6b6250',
};
const PHRASE = {
  farm: 'a farm village', desert: 'a desert boomtown', capital: 'a planned capital', mountain: 'a mountain city',
  university: 'a university town', port: 'a port city', smalltown: 'a small town', manhattan: 'Manhattan', hongkong: 'Hong Kong',
  tokyo: 'Tokyo', la: 'Los Angeles', paris: 'Paris', venice: 'Venice', barcelona: 'Barcelona',
};
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Verdana 11px advance widths, near enough; textLength makes the renderer fit the text to them exactly
function verdana(t) {
  let w = 0;
  for (const ch of t) w += /[il.,:;'|!]/.test(ch) ? 3.4 : /[fjrt ]/.test(ch) ? 4.3 : /[mw]/.test(ch) ? 9.4 : /[MW]/.test(ch) ? 10.6 : /[A-Z]/.test(ch) ? 7.4 : /[0-9]/.test(ch) ? 7 : 6.6;
  return Math.ceil(w);
}
const mono = (t, px) => Math.ceil(t.length * px * 0.6);
const icon = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s / 32})" shape-rendering="crispEdges">${ICON}</g>`;

// city: { kind, buildings } or null when the repo hasn't been built yet
export function badgeSVG(style, city) {
  const right = city ? `built like ${PHRASE[city.kind] || city.kind}` : 'see the city';
  const color = (city && KIND_COLOR[city.kind]) || '#4a4458';
  const title = esc(city ? `gitropolis: ${right}` : 'gitropolis: see this repo as a city');
  if (style === 'pixel') {
    const label = city ? PHRASE[city.kind] || city.kind : 'see the city', lead = city ? 'built like ' : '';
    const tw = mono(lead + label, 12), W = 4 + 18 + 6 + tw + 10 + 2, H = 24;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 2}" height="${H + 2}" viewBox="0 0 ${W + 2} ${H + 2}" role="img" aria-label="${title}"><title>${title}</title>
<rect x="2" y="2" width="${W}" height="${H}" fill="#14121c"/><rect width="${W}" height="${H}" fill="#14121c"/><rect x="2" y="2" width="${W - 4}" height="${H - 4}" fill="#f2efe9"/>
${icon(5, 3, 18)}
<text x="28" y="16.5" font-family="'Courier New',Courier,monospace" font-size="12" fill="#14121c" textLength="${tw}">${esc(lead)}<tspan fill="${color}" font-weight="bold">${esc(label)}</tspan></text></svg>`;
  }
  if (style === 'card') {
    const line1 = 'gitropolis', line2 = city ? `${right} · ${city.buildings.toLocaleString('en')} buildings` : 'see this repo as a city';
    const tw = Math.max(mono(line1, 12), mono(line2, 11)), W = 4 + 28 + 8 + tw + 10, H = 34;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><title>${title}</title>
<rect width="${W}" height="${H}" rx="2" fill="#14121c"/><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="1" fill="#86bfd9"/>
${icon(4, 3, 28)}
<text font-family="'Courier New',Courier,monospace" fill="#14121c"><tspan x="40" y="15" font-size="12" font-weight="bold" textLength="${mono(line1, 12)}">${line1}</tspan><tspan x="40" y="27" font-size="11" textLength="${mono(line2, 11)}">${esc(line2)}</tspan></text></svg>`;
  }
  // flat, like shields.io
  const lw = 4 + 14 + 4 + verdana('gitropolis') + 6, rw = 6 + verdana(right) + 6, W = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" viewBox="0 0 ${W} 20" role="img" aria-label="${title}"><title>${title}</title>
<clipPath id="r"><rect width="${W}" height="20" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#14121c"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>
${icon(4, 3, 14)}
<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="22" y="14" textLength="${verdana('gitropolis')}">gitropolis</text><text x="${lw + 6}" y="14" textLength="${verdana(right)}">${esc(right)}</text></g></svg>`;
}
