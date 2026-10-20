// While a city is being surveyed: a little pixel-art building site. A tower crane lifts bricks onto a
// building that grows floor by floor (and then starts the next one), clouds drift, a car goes by,
// and the line underneath says what the surveyors are up to. Drawn at art resolution, scaled up
// with hard pixels, in the city's own palette.
const W = 120, H = 64;
const C = {
  ink: '#14121c', cloud: '#f2efe9', cloudShade: '#cdc8d2', grass: '#61944a', grassDark: '#3d6b36', road: '#6e6880', line: '#e0d7b8',
  brick: '#b8684e', brickDark: '#8c4a3c', glass: '#86bfd9', glassLit: '#f2c14e', crane: '#f2c14e', craneDark: '#c0413b', steel: '#4a4458',
  car: ['#c0413b', '#2f6188', '#f2c14e'], sand: '#bdb293',
};
const STEPS = ['reading the git history', 'clearing the land', 'laying out the streets', 'raising the towers', 'planting the trees', 'turning on the lights'];

export function startWaiting(host, label) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText = `width:min(${W * 5}px, 86vw); image-rendering:pixelated; display:block; margin:0 auto 18px;`;
  const caption = document.createElement('div');
  const sub = document.createElement('div');
  sub.style.cssText = 'opacity:.7; font-size:.85em; margin-top:8px; min-height:1.2em;';
  caption.textContent = label;
  host.replaceChildren(canvas, caption, sub);
  const g = canvas.getContext('2d');
  const px = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };

  const GROUND = 52, PILE_X = 44, FLOOR = 4, MAX_FLOORS = 7;
  const lots = [{ x: 58, w: 14 }, { x: 78, w: 12 }, { x: 96, w: 16 }];
  const FLOOR_T = 1.5; // seconds per lifted floor
  const clouds = [{ x: 10, y: 8, w: 18 }, { x: 60, y: 4, w: 24 }, { x: 98, y: 12, w: 14 }];
  // start a couple of floors in, so the site isn't empty when it first appears
  let raf = 0, t0 = performance.now() - FLOOR_T * 2000, step = 0, stepAt = 0;

  function cloud(x, y, w) {
    x = ((x % (W + 30)) + W + 30) % (W + 30) - 30;
    px(x + 2, y, w - 4, 2, C.cloud); px(x, y + 2, w, 3, C.cloud); px(x + 1, y + 5, w - 2, 1, C.cloudShade);
    px(x + w * 0.3, y - 2, w * 0.35, 2, C.cloud);
  }
  function building(lot, floors, lit) {
    const top = GROUND - floors * FLOOR;
    for (let f = 0; f < floors; f++) {
      const y = GROUND - (f + 1) * FLOOR;
      px(lot.x, y, lot.w, FLOOR, f % 2 ? C.brick : C.brickDark);
      for (let wx = lot.x + 2; wx < lot.x + lot.w - 2; wx += 4) px(wx, y + 1, 2, 2, lit && (wx + f) % 3 === 0 ? C.glassLit : C.glass);
    }
    if (floors) px(lot.x - 1, top - 1, lot.w + 2, 1, C.ink);
    return top;
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, W, H);
    for (const c of clouds) cloud(c.x + t * (c.w > 20 ? 1.5 : 2.5), c.y, c.w);
    // ground, road with dashes, a sand pile of bricks waiting at the foot of the crane
    px(0, GROUND, W, H - GROUND, C.grass);
    px(0, GROUND + 4, W, 5, C.road);
    for (let x = -((t * 6) % 8); x < W; x += 8) px(x, GROUND + 6, 3, 1, C.line);
    for (let x = 0; x < W; x += 5) px(x, GROUND, 2, 1, C.grassDark);
    px(PILE_X - 5, GROUND - 2, 10, 2, C.sand);
    px(PILE_X - 3, GROUND - 4, 3, 2, C.brick); px(PILE_X + 1, GROUND - 4, 3, 2, C.brickDark);

    // which floor of which building is going up right now
    const lifted = Math.floor(t / FLOOR_T), phase = (t / FLOOR_T) % 1;
    const per = MAX_FLOORS, cycle = lots.length * per + 2; // two beats of rest when the block is done
    const k = lifted % cycle, done = Math.min(k, lots.length * per);
    const active = Math.min(lots.length - 1, Math.floor(done / per));
    let topActive = GROUND;
    lots.forEach((lot, i) => {
      const floors = Math.max(0, Math.min(per, done - i * per));
      const top = building(lot, floors, k >= lots.length * per);
      if (i === active) topActive = top;
    });

    // the crane: mast by the pile, a jib out over the lots, a trolley and hook carrying a brick
    const MAST = 30, JIB_Y = 12;
    px(MAST, JIB_Y, 3, GROUND - JIB_Y, C.crane);
    for (let y = JIB_Y + 2; y < GROUND; y += 4) px(MAST, y, 3, 1, C.craneDark);
    px(MAST - 14, JIB_Y - 1, 14, 2, C.crane); px(MAST - 16, JIB_Y - 2, 4, 4, C.steel); // counter-jib and weight
    px(MAST, JIB_Y - 1, W - MAST - 4, 2, C.crane);
    px(MAST + 1, JIB_Y - 6, 1, 5, C.crane); // the A-frame
    px(MAST - 1, JIB_Y + 1, 5, 3, C.craneDark); // cab
    const target = lots[active], dropX = target.x + target.w / 2;
    const resting = k >= lots.length * per;
    // phase: 0–.25 lower to the pile, .25–.4 lift, .4–.7 travel, .7–.85 lower onto the roof, .85–1 travel back
    const ease = s => s * s * (3 - 2 * s), seg = (a, b) => ease(Math.min(1, Math.max(0, (phase - a) / (b - a))));
    const homeX = PILE_X; // the hook waits over the brick pile
    let x = homeX, hookY = JIB_Y + 8, carrying = false;
    if (!resting) {
      if (phase < 0.25) { x = homeX; hookY = JIB_Y + 8 + (GROUND - 6 - JIB_Y - 8) * seg(0, 0.25); }
      else if (phase < 0.4) { x = homeX; hookY = GROUND - 6 - (GROUND - 6 - JIB_Y - 8) * seg(0.25, 0.4); carrying = true; }
      else if (phase < 0.7) { x = homeX + (dropX - homeX) * seg(0.4, 0.7); carrying = true; }
      else if (phase < 0.85) { x = dropX; hookY = JIB_Y + 8 + (topActive - FLOOR - 2 - JIB_Y - 8) * seg(0.7, 0.85); carrying = phase < 0.84; }
      else { x = dropX + (homeX - dropX) * seg(0.85, 1); }
    }
    px(x - 2, JIB_Y + 1, 5, 2, C.steel); // trolley
    px(x, JIB_Y + 3, 1, hookY - JIB_Y - 3, C.ink); // cable
    px(x - 1, hookY, 3, 1, C.steel);
    if (carrying) px(x - 3, hookY + 1, 7, 3, C.brick);

    // a car going by now and then
    const cx = ((t * 18) % (W + 60)) - 20;
    const col = C.car[Math.floor(t / ((W + 60) / 18)) % C.car.length];
    px(cx, GROUND + 4, 9, 3, col); px(cx + 2, GROUND + 2, 5, 2, col); px(cx + 3, GROUND + 2, 3, 1, C.glass);
    px(cx + 1, GROUND + 7, 2, 1, C.ink); px(cx + 6, GROUND + 7, 2, 1, C.ink);

    // the surveyors' progress line
    if (t - stepAt > 3.2 + (step === 0 ? FLOOR_T * 2 : 0)) { step = Math.min(step + 1, STEPS.length - 1); stepAt = t; }
    const dots = '.'.repeat(1 + Math.floor(t * 2) % 3);
    if (sub.textContent !== STEPS[step] + dots) sub.textContent = STEPS[step] + dots;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
