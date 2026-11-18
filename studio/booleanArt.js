/**
 * The Boolean artwork, generated live for the studio's Weather and Attendance
 * pieces in place of a rendered video. Inspired by the "booleanSequence"
 * generative piece by niceunderground: a field of cells that each hold one of
 * two values and never a third, drawn as a pair of signs.
 *
 * One rule, four verbs:
 * - Enter:   the whole field drifts, and new cells slide in at the frame's
 *            edge, each already carrying one value (cut from slow noise, so
 *            they arrive as little territories).
 * - Attract: cells swap places with a neighbour when that leaves them among
 *            more of their own value, so like gathers with like.
 * - Exclude: a cell on a border is only ever one value or the other; the
 *            borders wander and cells flip along them, but the two never merge.
 * - Leave:   whatever drifts out of the frame is gone, and nothing lasts.
 *
 * The cells are simulated on the CPU (a grid of about a thousand) and drawn on
 * the GPU, the signs being shapes in the shader, so it needs only WebGL 2.
 *
 * The studio colours a video art from two films played in step: the render in
 * grey, and a "velocity pass" that marks how lively each pixel is (black
 * still, white fast). This art draws both into one texture: the render in the
 * top half and its velocity pass in the bottom half, the same size. A cell is
 * lively when it has just entered, swapped or flipped, and cells on a border
 * are livelier than those deep in a territory. Wind (setWind) makes the field
 * drift faster and the borders rougher.
 *
 * In Weather, the design also comes together as the shape of the place's
 * country (setLocation), then falls apart again, over and over: the shape
 * builds in a sweep across the space, stands a while, and collapses in a sweep.
 * The wind's speed sets how fast the cycle runs.
 */

const CELLS = 40; // across the frame
const SCROLL = 0.85; // cells per second the field drifts
const TURN = 0.045; // radians per second the drift's direction turns
const ATTRACT = 14; // swap attempts per cell per second
const FLIPS = 1.6; // border flip attempts per cell per second
const TERRITORY = 0.14; // noise frequency of the territories that enter, per cell
const DECAY = 1.5; // per second, how fast a cell's liveliness fades
const BORDER_LIVELY = 0.38; // the least liveliness a cell on a border has
const CALM_LIVELY = 0.06; // and one deep in a territory
const DEFAULT_ENERGY = 0.3;
const FULL_WIND_KPH = 40;
const CALM_PACE = 0.7;
const FULL_PACE = 2.2;

// The pair of signs a value shows, by alphabet: + −, 0 1, > <.
export const ALPHABETS = ["brackets", "plus-minus", "zero-one", "greater-less"];

// The studio's weather places and the country each one is the design's shape
// (ISO 3166-1 numeric, as world-atlas names its countries).
const LOCATION_ISO = {
  bengaluru: "356",
  reykjavik: "352",
  oslo: "578",
  london: "826",
  newyork: "840",
  tokyo: "392",
  dubai: "784",
  cairo: "818",
  sydney: "036",
  riodejaneiro: "076",
};

// One cycle of the design coming together as the country and collapsing again,
// in seconds: slow in a calm, quick in a gale. Its parts, as shares of the cycle.
const CYCLE_CALM = 45;
const CYCLE_GALE = 7;
const ASSEMBLE = [0.02, 0.4]; // the shape builds across the space
const COLLAPSE = [0.44, 0.98]; // and later falls apart across it, then it begins again
const SHAPE_FILL = 0.8; // how much of the frame's height the country fills at most
const SHAPE_FILL_W = 0.72; // and of its width

// The country's polygons as rings of [lon, lat], loaded the first time one is
// asked for. Far-flung pieces (Alaska, Svalbard) are left out so the shape
// is the country as it's known, not its farthest island.
let countries;
async function loadCountry(iso) {
  countries ??= Promise.all([import("topojson-client"), import("world-atlas/countries-110m.json")]).then(
    ([{ feature }, { default: world }]) => new Map(feature(world, world.objects.countries).features.map((f) => [f.id, f.geometry])),
  );
  const geometry = (await countries).get(iso);
  if (!geometry) return null;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const boxOf = (poly) => {
    const lons = poly[0].map((p) => p[0]);
    const lats = poly[0].map((p) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  };
  // True area (shoelace, in square degrees), not the box's: a thin chain of islands has a big box.
  const areaOf = (ring) => Math.abs(ring.reduce((sum, [x, y], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    return sum + (x * y2 - x2 * y);
  }, 0)) / 2;
  const sized = polys.map((poly) => ({ poly, box: boxOf(poly), area: areaOf(poly[0]) })).sort((p, q) => q.area - p.area);
  const main = sized[0];
  // A piece is kept if it is big enough and sits near the main piece: within its box, grown by a third.
  const padX = 0.35 * (main.box[2] - main.box[0]);
  const padY = 0.35 * (main.box[3] - main.box[1]);
  return sized
    .filter((p) => p === main || (p.area >= 0.04 * main.area
      && (p.box[0] + p.box[2]) / 2 >= main.box[0] - padX && (p.box[0] + p.box[2]) / 2 <= main.box[2] + padX
      && (p.box[1] + p.box[3]) / 2 >= main.box[1] - padY && (p.box[1] + p.box[3]) / 2 <= main.box[3] + padY))
    .map((p) => p.poly);
}

// Whether a point is inside a polygon (its first ring the outline, any others holes).
function inside(poly, lon, lat) {
  let hit = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

// The art's only two colours: black, and the data's colour (the temperature's
// hue in Weather, the mosaic's green otherwise).
const BLACK = [0.02, 0.025, 0.03];
const MOSAIC_GREEN = [0x7c / 255, 0xf0 / 255, 0x4b / 255];

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  };
  return [f(5), f(3), f(1)];
}

const VERTEX = /* glsl */ `#version 300 es
  layout(location = 0) in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = /* glsl */ `#version 300 es
  precision highp float;
  uniform sampler2D uCells; // r: the value, g: how lively the cell is
  uniform float uCellPx; // a cell's size in pixels
  uniform vec2 uOff; // how far the field has drifted into the next cell, in cells
  uniform vec2 uGrid; // the cell texture's size
  uniform float uY0; // where this pass starts in the texture, in pixels
  uniform float uVelocity; // 1 for the velocity pass
  uniform int uAlphabet;
  uniform vec3 uColor;
  uniform vec3 uBlack;
  out vec4 outColor;

  float box(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }

  // The sign for a value, as a distance (negative inside), in a cell -0.5..0.5.
  float sign_(vec2 p, bool on) {
    if (uAlphabet == 0) {
      // [ and ]: a stem with a short serif at each end.
      vec2 q = on ? p : vec2(-p.x, p.y);
      q.x += 0.05;
      return min(box(q - vec2(-0.1, 0.0), vec2(0.035, 0.3)),
        min(box(q - vec2(0.0, 0.265), vec2(0.1, 0.035)), box(q - vec2(0.0, -0.265), vec2(0.1, 0.035))));
    }
    if (uAlphabet == 1) {
      float bar = box(p, vec2(0.27, 0.055));
      return on ? min(bar, box(p, vec2(0.055, 0.27))) : bar;
    }
    if (uAlphabet == 2) {
      if (on) return min(box(p - vec2(0.03, 0.0), vec2(0.05, 0.28)), seg(p, vec2(-0.17, 0.13), vec2(0.03, 0.27)) - 0.05);
      return abs(length(p * vec2(1.25, 0.95)) - 0.23) - 0.05;
    }
    vec2 q = on ? p : vec2(-p.x, p.y);
    return min(seg(q, vec2(-0.13, 0.27), vec2(0.14, 0.0)), seg(q, vec2(0.14, 0.0), vec2(-0.13, -0.27))) - 0.05;
  }

  void main() {
    vec2 g = (gl_FragCoord.xy - vec2(0.0, uY0)) / uCellPx + uOff;
    ivec2 c = clamp(ivec2(floor(g)), ivec2(0), ivec2(uGrid) - 1);
    vec4 cell = texelFetch(uCells, c, 0);
    bool on = cell.r > 0.5;
    float lively = cell.g;

    if (uVelocity > 0.5) {
      outColor = vec4(vec3(lively), 1.0);
      return;
    }

    // A lively cell's sign swells a little.
    vec2 p = (fract(g) - 0.5) / (1.0 + 0.2 * lively);
    float aa = 1.5 / uCellPx;
    float ink = smoothstep(aa, -aa, sign_(p, on));
    // Two colours and nothing else: the data's colour and black. Each value is
    // one of them filled, its sign in the other.
    vec3 ground = on ? uColor : uBlack;
    vec3 sign = on ? uBlack : uColor;
    outColor = vec4(mix(ground, sign, ink), 1.0);
  }
`;

// A repeatable hash of a lattice point, 0..1.
function hash(x, y) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise, 0..1.
function noise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * ux;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

function target(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

function drop(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/**
 * Starts the art in the caller's WebGL 2 context, so what it draws never has
 * to be copied between contexts. Returns its texture (the render on top, its
 * velocity pass below) and the means to size it, set its wind, draw the next
 * frame and read a small copy back; or null without WebGL 2.
 *
 * It leaves the context as the caller's own drawing expects: no framebuffer,
 * vertex array or program of its own bound, no scissor, depth test or
 * blending, and the unpack settings as they were.
 */
export function createBooleanArt(gl) {
  if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return null;

  const prog = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[Boolean]", gl.getShaderInfoLog(shader));
      return null;
    }
    gl.attachShader(prog, shader);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("[Boolean]", gl.getProgramInfoLog(prog));
    return null;
  }
  const u = {};
  for (const name of ["uCells", "uCellPx", "uOff", "uGrid", "uY0", "uVelocity", "uAlphabet", "uColor", "uBlack"]) {
    u[name] = gl.getUniformLocation(prog, name);
  }

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let width = 0;
  let height = 0;
  let out = null; // what it draws into: the two passes
  let small = null; // a small copy, for reading back (see readSmall)
  let alphabet = 0;
  let color = MOSAIC_GREEN;
  let energy = DEFAULT_ENERGY;
  let energyTarget = DEFAULT_ENERGY;

  // The field: (gw × gh) cells, one more each way than the frame shows, so the
  // drift between two cells always has a cell to show.
  let gw = 0;
  let gh = 0;
  let cellPx = 1;
  let value = new Uint8Array(0);
  let lively = new Float32Array(0);
  let bytes = new Uint8Array(0);
  let cellTex = null;
  let off = [0, 0]; // the drift into the next cell, 0..1 each way
  let world = [0, 0]; // how many cells the field has drifted, for the noise
  // The way the field travels on screen (x right, y up), as an angle. With a
  // wind direction it turns to follow it; without, it turns slowly on its own.
  let heading = Math.random() * Math.PI * 2;
  let windHeading = null;
  let seed = [Math.random() * 1000, Math.random() * 1000];
  let time = 0;

  // The country the design comes together as, and where we are in its cycle.
  let iso = null;
  let polygons = null; // the country's, once loaded
  let mask = null; // per cell, 1 inside the country
  let delay = new Float32Array(0); // per cell, 0..1, when the cycle's sweeps reach it
  let forced = new Uint8Array(0); // per cell, 1 while it is held to the shape
  let phase = 0; // 0..1 through the cycle
  let strength = 0; // how much of the shape stands, 0..1

  const at = (x, y) => y * gw + x;

  // The value a cell entering at the field's (x, y) takes, cut from slow noise.
  function entering(x, y) {
    const wx = (x + world[0]) * TERRITORY + seed[0];
    const wy = (y + world[1]) * TERRITORY + seed[1] + time * 0.04;
    const n = noise(wx, wy) * 0.65 + noise(wx * 2.3 + 40, wy * 2.3) * 0.35;
    return n > 0.5 ? 1 : 0;
  }

  function fillAll() {
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        value[at(x, y)] = entering(x, y);
        lively[at(x, y)] = Math.random() * 0.5;
      }
    }
  }

  // The country, fitted to the frame and cut into cells.
  function buildMask() {
    mask = null;
    if (!polygons || !gw) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const poly of polygons) {
      for (const [lon, lat] of poly[0]) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
    }
    const lonC = (minLon + maxLon) / 2;
    const latC = (minLat + maxLat) / 2;
    const squash = Math.cos((latC * Math.PI) / 180); // degrees of longitude are narrower away from the equator
    const scale = Math.min((SHAPE_FILL * height) / (maxLat - minLat), (SHAPE_FILL_W * width) / ((maxLon - minLon) * squash));
    mask = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const lon = lonC + ((x + 0.5) * cellPx - width / 2) / (scale * squash);
        const lat = latC + ((y + 0.5) * cellPx - height / 2) / scale;
        mask[at(x, y)] = polygons.some((poly) => inside(poly, lon, lat)) ? 1 : 0;
      }
    }
  }

  // When the cycle's sweeps reach each cell: they cross the space the way the
  // field travels, with a little scatter so the front is ragged, not a line.
  function computeDelay() {
    const reach = Math.hypot(gw, gh) / 2;
    const cx = Math.cos(heading);
    const cy = Math.sin(heading);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const along = ((x - gw / 2) * cx + (y - gh / 2) * cy) / reach; // -1..1
        delay[at(x, y)] = 0.5 + 0.44 * along + (hash(x * 7 + 3, y * 13 + 5) - 0.5) * 0.12;
      }
    }
  }

  // Moves the cycle on and holds the cells it has reached to the shape, or lets
  // them go back to the field.
  function cycle(dt) {
    if (!mask) { strength = 0; return; }
    const rate = 1 / CYCLE_CALM + energy * (1 / CYCLE_GALE - 1 / CYCLE_CALM);
    phase += dt * rate;
    if (phase >= 1) { phase -= 1; computeDelay(); }
    const through = (span) => Math.min(Math.max((phase - span[0]) / (span[1] - span[0]), 0), 1) * 1.12;
    const built = through(ASSEMBLE);
    const gone = through(COLLAPSE);
    strength = Math.min(built, 1) - Math.min(gone, 1);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = at(x, y);
        if (delay[i] < built && !(delay[i] < gone)) {
          if (value[i] !== mask[i]) { value[i] = mask[i]; lively[i] = 1; }
          forced[i] = 1;
        } else if (forced[i]) {
          // Let go, a cell turns to either value at random: the shape comes apart
          // into speckle, which then gathers into territories again.
          forced[i] = 0;
          value[i] = Math.random() < 0.5 ? 1 : 0;
          lively[i] = 1;
        }
      }
    }
  }

  // The field has drifted a whole cell: every cell moves over one, and a fresh
  // column (or row) enters on the far side.
  function shift(dx, dy) {
    if (dx) {
      for (let y = 0; y < gh; y++) {
        const row = y * gw;
        if (dx > 0) {
          value.copyWithin(row, row + 1, row + gw);
          lively.copyWithin(row, row + 1, row + gw);
        } else {
          value.copyWithin(row + 1, row, row + gw - 1);
          lively.copyWithin(row + 1, row, row + gw - 1);
        }
      }
      world[0] += dx;
      const x = dx > 0 ? gw - 1 : 0;
      for (let y = 0; y < gh; y++) {
        value[at(x, y)] = entering(x, y);
        lively[at(x, y)] = 1;
      }
    }
    if (dy) {
      if (dy > 0) {
        value.copyWithin(0, gw);
        lively.copyWithin(0, gw);
      } else {
        value.copyWithin(gw, 0, gw * (gh - 1));
        lively.copyWithin(gw, 0, gw * (gh - 1));
      }
      world[1] += dy;
      const y = dy > 0 ? gh - 1 : 0;
      for (let x = 0; x < gw; x++) {
        value[at(x, y)] = entering(x, y);
        lively[at(x, y)] = 1;
      }
    }
  }

  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // How many of a cell's four neighbours hold the value v, ignoring the cell (sx, sy).
  function likeAround(x, y, v, sx, sy) {
    let n = 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || (nx === sx && ny === sy)) continue;
      if (value[at(nx, ny)] === v) n++;
    }
    return n;
  }

  // Attract and exclude: a cell trades places with a neighbour when each ends
  // up among more of its own, now and then against its better judgement (the
  // grain, which grows with the wind), and cells on a border sometimes flip.
  function settle(dt) {
    const cells = gw * gh;
    const grain = 0.05 + 0.18 * energy;
    const swaps = Math.round(cells * ATTRACT * dt);
    for (let i = 0; i < swaps; i++) {
      const x = Math.floor(Math.random() * gw);
      const y = Math.floor(Math.random() * gh);
      const [dx, dy] = NEIGHBOURS[Math.floor(Math.random() * 4)];
      const bx = x + dx;
      const by = y + dy;
      if (bx < 0 || by < 0 || bx >= gw || by >= gh) continue;
      const a = at(x, y);
      const b = at(bx, by);
      if (value[a] === value[b]) continue;
      const before = likeAround(x, y, value[a], bx, by) + likeAround(bx, by, value[b], x, y);
      const after = likeAround(x, y, value[b], bx, by) + likeAround(bx, by, value[a], x, y);
      const gain = after - before;
      if (gain > 0 || (gain === 0 && Math.random() < 0.5) || Math.random() < grain * Math.exp(gain * 1.2)) {
        [value[a], value[b]] = [value[b], value[a]];
        lively[a] = lively[b] = 1;
      }
    }
    // Cells turning from one value to the other: rare in a calm, constant in a
    // gale. On a border they turn readily; deep in a territory, only in wind.
    const flips = Math.round(cells * FLIPS * dt * (0.1 + 3.5 * energy));
    for (let i = 0; i < flips; i++) {
      const x = Math.floor(Math.random() * gw);
      const y = Math.floor(Math.random() * gh);
      const v = value[at(x, y)];
      if ((likeAround(x, y, v, -1, -1) <= 1 && Math.random() < 0.6) || Math.random() < 0.3 * energy) {
        value[at(x, y)] = 1 - v;
        lively[at(x, y)] = 1;
      }
    }
  }

  function step(dt) {
    time += dt;
    if (windHeading === null) heading += TURN * dt;
    else {
      let delta = windHeading - heading;
      delta -= Math.PI * 2 * Math.round(delta / (Math.PI * 2));
      heading += delta * (1 - Math.exp(-dt / 1.5));
    }
    // The drift follows the wind: nearly still in a calm, racing in a gale.
    // It holds nearly still while the shape stands, so the shape stays sharp.
    const speed = SCROLL * (0.15 + 3.2 * energy) * (1 - 0.92 * strength);
    // The cells travel one way, so what they show moves the other way through the grid.
    off[0] -= Math.cos(heading) * speed * dt;
    off[1] -= Math.sin(heading) * speed * dt;
    while (off[0] >= 1) { off[0] -= 1; shift(1, 0); }
    while (off[0] < 0) { off[0] += 1; shift(-1, 0); }
    while (off[1] >= 1) { off[1] -= 1; shift(0, 1); }
    while (off[1] < 0) { off[1] += 1; shift(0, -1); }

    settle(dt * (CALM_PACE + (FULL_PACE - CALM_PACE) * energy));
    cycle(dt);

    const fade = Math.exp(-dt * DECAY);
    for (let i = 0; i < lively.length; i++) lively[i] *= fade;
  }

  // Sends the field to its texture: the value, and how lively each cell is,
  // with the cells along a border livelier than those deep in a territory.
  function upload() {
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = at(x, y);
        const v = value[i];
        const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1;
        const border = !edge && likeAround(x, y, v, -1, -1) < 4;
        const floor = border ? BORDER_LIVELY : CALM_LIVELY;
        bytes[i * 4] = v ? 255 : 0;
        bytes[i * 4 + 1] = Math.round(Math.min(Math.max(lively[i], floor), 1) * 255);
        bytes[i * 4 + 3] = 255;
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  function rebuild() {
    cellPx = width / CELLS;
    gw = CELLS + 1;
    gh = Math.ceil(height / cellPx) + 1;
    value = new Uint8Array(gw * gh);
    lively = new Float32Array(gw * gh);
    bytes = new Uint8Array(gw * gh * 4);
    off = [0, 0];
    world = [0, 0];
    seed = [Math.random() * 1000, Math.random() * 1000];
    delay = new Float32Array(gw * gh);
    forced = new Uint8Array(gw * gh);
    phase = 0;
    strength = 0;
    fillAll();
    computeDelay();
    buildMask();
    if (cellTex) gl.deleteTexture(cellTex);
    cellTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, gw, gh);
  }

  // Draws one pass into the half of the texture that starts y pixels up.
  function draw(y, velocity) {
    gl.viewport(0, y, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y, width, height);
    gl.uniform1f(u.uY0, y);
    gl.uniform1f(u.uVelocity, velocity ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return {
    /** It colours itself (see setHue), so the studio shows it as it is. */
    flat: true,

    /** The two passes: the render in the top half, its velocity pass below. */
    get texture() { return out ? out.tex : null; },
    /** Each pass's size in pixels (the texture is twice as tall). */
    get width() { return width; },
    get height() { return height; },

    resize(w, h) {
      w = Math.max(2, Math.round(w));
      h = Math.max(2, Math.round(h));
      if (w === width && h === height) return;
      width = w;
      height = h;
      drop(gl, out);
      out = target(gl, w, h * 2);
      rebuild();
    },

    /** The wind in km/h, or null for the field's usual drift. */
    setWind(kph) {
      energyTarget = Number.isFinite(kph) ? Math.min(Math.max(kph, 0) / FULL_WIND_KPH, 1) : DEFAULT_ENERGY;
    },

    /** How fast the field's clock runs in this wind, in seconds per second. */
    paceFor(kph) {
      const e = Number.isFinite(kph) ? Math.min(Math.max(kph, 0) / FULL_WIND_KPH, 1) : DEFAULT_ENERGY;
      return CALM_PACE + (FULL_PACE - CALM_PACE) * e;
    },

    /**
     * Where the wind blows from, in degrees clockwise from north (north up the
     * screen), which the cells then travel away from; or null for no
     * direction, when they turn slowly on their own.
     */
    setWindFrom(degrees) {
      if (!Number.isFinite(degrees)) { windHeading = null; return; }
      const to = ((degrees + 180) * Math.PI) / 180; // clockwise from north, where it blows to
      windHeading = Math.atan2(Math.cos(to), Math.sin(to)); // x east, y north
    },

    /**
     * The weather place (an id such as "tokyo") whose country the design comes
     * together as, again and again; or null for none, when it stays a field.
     */
    setLocation(id) {
      const next = LOCATION_ISO[id] ?? null;
      if (next === iso) return;
      iso = next;
      polygons = null;
      mask = null;
      forced.fill(0);
      phase = 0;
      strength = 0;
      if (!iso) return;
      loadCountry(iso).then((found) => {
        if (iso !== next || !found) return;
        polygons = found;
        buildMask();
      }).catch((err) => console.error("[Boolean]", err));
    },

    /** The colour of one value, from a hue 0..1 (the temperature's), or the mosaic's green for null. */
    setHue(h) {
      color = Number.isFinite(h) ? hsv(((h % 1) + 1) % 1, 0.95, 1) : MOSAIC_GREEN;
    },

    /** Which pair of signs the cells show (an index into ALPHABETS). */
    setAlphabet(i) {
      alphabet = ((Math.round(i) % ALPHABETS.length) + ALPHABETS.length) % ALPHABETS.length;
    },

    /** Moves the field on by dt real seconds and draws it. */
    render(dt) {
      if (!width || !height) return;
      // Its own uploads are raw data, never flipped.
      const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
      const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      dt = Math.min(Math.max(dt || 0, 0), 0.1); // a stalled tab doesn't jump ahead
      energy += (energyTarget - energy) * (1 - Math.exp(-dt / 1.2));
      if (dt > 0) step(dt);
      upload();

      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cellTex);
      gl.uniform1i(u.uCells, 0);
      gl.uniform1f(u.uCellPx, cellPx);
      gl.uniform2f(u.uOff, off[0], off[1]);
      gl.uniform2f(u.uGrid, gw, gh);
      gl.uniform1i(u.uAlphabet, alphabet);
      gl.uniform3fv(u.uColor, color);
      gl.uniform3fv(u.uBlack, BLACK);
      gl.bindVertexArray(quad);
      draw(height, false); // the render, in the top half
      draw(0, true); // its velocity pass, below

      gl.disable(gl.SCISSOR_TEST);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(null);
      gl.activeTexture(gl.TEXTURE0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    },

    /**
     * Both passes scaled down to w × h each and read back as RGBA bytes,
     * bottom row first: { main, velocity }, pixel for pixel alike.
     *
     * Unless `now`, it doesn't wait for the GPU, which would stall drawing:
     * it starts a read and hands back the last one finished, a frame or two
     * old (null until the first is). With `now` it reads and waits.
     */
    readSmall(w, h, now = false) {
      if (!out) return null;
      if (!small || small.w !== w || small.h !== h * 2) {
        drop(gl, small);
        if (small?.pbo) gl.deleteBuffer(small.pbo);
        if (small?.fence) gl.deleteSync(small.fence);
        small = target(gl, w, h * 2);
        small.pixels = new Uint8Array(w * h * 2 * 4);
        small.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, small.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, small.pixels.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        small.ready = false;
        small.fence = null;
      }
      const n = w * h * 4;
      const result = () => ({ velocity: small.pixels.subarray(0, n), main: small.pixels.subarray(n, 2 * n) });

      // Collect the read in flight, if the GPU has finished it.
      if (small.fence) {
        const state = gl.clientWaitSync(small.fence, 0, 0);
        if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, small.pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, small.pixels);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.deleteSync(small.fence);
          small.fence = null;
          small.ready = true;
        } else if (!now) {
          return small.ready ? result() : null;
        }
      }

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, out.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, small.fbo);
      gl.blitFramebuffer(0, 0, out.w, out.h, 0, 0, small.w, small.h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, small.fbo);
      if (now) {
        if (small.fence) { gl.deleteSync(small.fence); small.fence = null; }
        gl.readPixels(0, 0, small.w, small.h, gl.RGBA, gl.UNSIGNED_BYTE, small.pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        small.ready = true;
        return result();
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, small.pbo);
      gl.readPixels(0, 0, small.w, small.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      small.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      return small.ready ? result() : null;
    },

    dispose() {
      drop(gl, out);
      if (small?.pbo) gl.deleteBuffer(small.pbo);
      if (small?.fence) gl.deleteSync(small.fence);
      drop(gl, small);
      if (cellTex) gl.deleteTexture(cellTex);
      gl.deleteProgram(prog);
      gl.deleteVertexArray(quad);
      gl.deleteBuffer(quadBuffer);
    },
  };
}
