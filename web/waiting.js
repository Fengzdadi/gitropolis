// While a city is being surveyed: a little pixel-art building site. A tower crane lifts bricks onto a
// building that grows floor by floor (and then starts the next one), clouds drift, a car goes by,
// and the line underneath says what the surveyors are up to. Drawn at art resolution, scaled up
// with hard pixels, in the city's own palette.
//
// A few things for whoever waits long enough, or pokes at it: fireworks when a block is finished
// (and wherever you click), a car that honks back, the odd rubber duck on the hook (the Konami code
// makes it all ducks), a UFO that comes for a brick now and then, and captions for long waits.
const W = 120, H = 76;
const C = {
  ink: '#14121c', cloud: '#f2efe9', cloudShade: '#cdc8d2', grass: '#61944a', grassDark: '#3d6b36', road: '#6e6880', line: '#e0d7b8',
  brick: '#b8684e', brickDark: '#8c4a3c', glass: '#86bfd9', glassLit: '#f2c14e', crane: '#f2c14e', craneDark: '#c0413b', steel: '#4a4458',
  car: ['#c0413b', '#2f6188', '#f2c14e'], sand: '#bdb293', duck: '#f7d14a', beak: '#e8873a', ufo: '#9aa3b5', beam: 'rgba(190, 255, 170, .35)',
  spark: ['#f2c14e', '#ff6fae', '#86e0ff', '#f2efe9', '#9be36b'],
};
const STEPS = ['reading the git history', 'clearing the land', 'laying out the streets', 'raising the towers', 'planting the trees', 'turning on the lights'];
// once the steps run out and it's still going (a big repo, a cold scanner)
const LONG = ['waiting for the concrete to dry', 'resolving merge conflicts with the neighbours', 'rebasing the foundations',
  'git blame-ing the architect', 'squashing a few floors together', 'a big one — still pouring'];
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

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

  const GROUND = 62, PILE_X = 44, FLOOR = 4, JIB_Y = 10, MAST = 30;
  const lots = [{ x: 58, w: 14, floors: 7 }, { x: 78, w: 12, floors: 5 }, { x: 96, w: 16, floors: 9 }];
  const starts = lots.map((_, i) => lots.slice(0, i).reduce((s, l) => s + l.floors, 0));
  const TOTAL = lots.reduce((s, l) => s + l.floors, 0), REST = 4; // beats of fireworks when the block is done
  const FLOOR_T = 1.5; // seconds per lifted floor
  const clouds = [{ x: 10, y: 4, w: 18 }, { x: 60, y: 16, w: 24 }, { x: 98, y: 24, w: 14 }];
  // start a couple of floors in, so the site isn't empty when it first appears
  let raf = 0, t0 = performance.now() - FLOOR_T * 2000, last = 0, step = 0, stepAt = 0;
  const sparks = [];
  let honkAt = -9, carBox = null, ducks = false, keys = [], lastShow = -1;

  function burst(x, y, n = 16) {
    const c = C.spark[Math.floor(Math.random() * C.spark.length)];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3, v = 14 + Math.random() * 10;
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.9 + Math.random() * 0.4, c: Math.random() < 0.2 ? C.spark[3] : c });
    }
  }
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
  function duck(x, y) { // a rubber duck, for debugging
    px(x - 3, y + 1, 6, 3, C.duck); px(x, y - 1, 3, 2, C.duck); px(x + 3, y, 2, 1, C.beak); px(x + 1, y - 1, 1, 1, C.ink);
  }
  function ufo(t) { // drops by every 45 seconds or so, and borrows a brick
    const u = (t % 45 - 22) / 9;
    if (u < 0 || u > 1) return;
    const ease = s => s * s * (3 - 2 * s);
    let x, beam = 0;
    if (u < 0.35) x = -14 + (PILE_X + 14) * ease(u / 0.35);
    else if (u < 0.65) { x = PILE_X; beam = (u - 0.35) / 0.3; }
    else x = PILE_X + (W + 14 - PILE_X) * ease((u - 0.65) / 0.35);
    const y = 3 + Math.round(Math.sin(t * 3));
    if (beam) {
      g.fillStyle = C.beam;
      g.beginPath(); g.moveTo(x - 2, y + 3); g.lineTo(x + 3, y + 3); g.lineTo(x + 8, GROUND); g.lineTo(x - 7, GROUND); g.fill();
      px(x - 1, GROUND - 4 - (GROUND - 4 - y - 4) * beam, 3, 2, C.brick);
    }
    px(x - 2, y - 2, 5, 2, C.glass); px(x - 6, y, 13, 2, C.ufo); px(x - 4, y + 2, 9, 1, C.steel);
    if (Math.floor(t * 4) % 2) px(x - 5, y, 1, 1, C.glassLit); else px(x + 5, y, 1, 1, C.glassLit);
  }

  function frame(now) {
    const t = (now - t0) / 1000, dt = Math.min(0.05, last ? t - last : 0); last = t;
    g.clearRect(0, 0, W, H);
    for (const c of clouds) cloud(c.x + t * (c.w > 20 ? 1.5 : 2.5), c.y, c.w);
    ufo(t);
    // ground, road with dashes, a sand pile of bricks waiting at the foot of the crane
    px(0, GROUND, W, H - GROUND, C.grass);
    px(0, GROUND + 4, W, 5, C.road);
    for (let x = -((t * 6) % 8); x < W; x += 8) px(x, GROUND + 6, 3, 1, C.line);
    for (let x = 0; x < W; x += 5) px(x, GROUND, 2, 1, C.grassDark);
    px(PILE_X - 5, GROUND - 2, 10, 2, C.sand);
    px(PILE_X - 3, GROUND - 4, 3, 2, C.brick); px(PILE_X + 1, GROUND - 4, 3, 2, C.brickDark);

    // which floor of which building is going up right now
    const lifted = Math.floor(t / FLOOR_T), phase = (t / FLOOR_T) % 1;
    const k = lifted % (TOTAL + REST), done = Math.min(k, TOTAL), resting = k >= TOTAL;
    let active = lots.findIndex((l, i) => done < starts[i] + l.floors);
    if (active < 0) active = lots.length - 1;
    let topActive = GROUND;
    lots.forEach((lot, i) => {
      const top = building(lot, Math.max(0, Math.min(lot.floors, done - starts[i])), resting);
      if (i === active) topActive = top;
    });
    // the block is finished: fireworks over the roofs
    const show = resting ? Math.floor(t * 2.5) : -1;
    if (show !== lastShow && show >= 0) { const l = lots[show % lots.length]; burst(l.x + l.w / 2 + (Math.random() - 0.5) * 8, 8 + Math.random() * 12, 18); }
    lastShow = show;

    // the crane: mast by the pile, a jib out over the lots, a trolley and hook carrying a brick
    px(MAST, JIB_Y, 3, GROUND - JIB_Y, C.crane);
    for (let y = JIB_Y + 2; y < GROUND; y += 4) px(MAST, y, 3, 1, C.craneDark);
    px(MAST - 14, JIB_Y - 1, 14, 2, C.crane); px(MAST - 16, JIB_Y - 2, 4, 4, C.steel); // counter-jib and weight
    px(MAST, JIB_Y - 1, W - MAST - 4, 2, C.crane);
    px(MAST + 1, JIB_Y - 7, 1, 6, C.crane); // the A-frame
    px(MAST - 1, JIB_Y + 1, 5, 3, C.craneDark); // cab
    const target = lots[active], dropX = target.x + target.w / 2;
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
    // every so often the load is a rubber duck
    if (carrying) (ducks || (lifted * 7919) % 13 === 5) ? duck(x, hookY + 2) : px(x - 3, hookY + 1, 7, 3, C.brick);

    // a car going by now and then; poke it and it honks
    const cx = ((t * 18) % (W + 60)) - 20, hop = t - honkAt < 0.4 ? 1 : 0;
    const col = C.car[Math.floor(t / ((W + 60) / 18)) % C.car.length];
    px(cx, GROUND + 4 - hop, 9, 3, col); px(cx + 2, GROUND + 2 - hop, 5, 2, col); px(cx + 3, GROUND + 2 - hop, 3, 1, C.glass);
    px(cx + 1, GROUND + 7, 2, 1, C.ink); px(cx + 6, GROUND + 7, 2, 1, C.ink);
    carBox = [cx - 2, GROUND, cx + 11, GROUND + 9];
    if (t - honkAt < 1) { px(cx + 10, GROUND - 2 - hop, 1, 2, C.ink); px(cx + 12, GROUND - 4 - hop, 1, 3, C.ink); }

    // fireworks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt; if (s.life <= 0) { sparks.splice(i, 1); continue; }
      s.vy += 22 * dt; s.vx *= 1 - 1.5 * dt; s.vy *= 1 - 1.5 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.life > 0.25 || Math.floor(t * 20) % 2) px(s.x, s.y, 1, 1, s.c);
    }

    // the surveyors' progress line, and something to read when it takes a while
    if (t - stepAt > 3.2 + (step === 0 ? FLOOR_T * 2 : 0) && step < STEPS.length - 1) { step++; stepAt = t; }
    const wait = t - stepAt - 6;
    let line = wait > 0 && step === STEPS.length - 1 ? LONG[Math.floor(wait / 4.5) % LONG.length] : STEPS[step];
    if (t - honkAt < 1.2) line = 'beep beep';
    const dots = line === 'beep beep' ? '!' : '.'.repeat(1 + Math.floor(t * 2) % 3);
    if (sub.textContent !== line + dots) sub.textContent = line + dots;
    raf = requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
    if (carBox && x >= carBox[0] && x <= carBox[2] && y >= carBox[1] && y <= carBox[3]) honkAt = (performance.now() - t0) / 1000;
    else burst(x, y);
  });
  const onKey = e => {
    keys = [...keys, e.key.length === 1 ? e.key.toLowerCase() : e.key].slice(-KONAMI.length);
    if (keys.join() === KONAMI.join()) { ducks = !ducks; burst(MAST, JIB_Y, 24); }
  };
  addEventListener('keydown', onKey);
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey); };
}
