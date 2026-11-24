// The wallpaper's renderer: one fragment shader over the whole box (WebGL2). A painting is a GLSL function,
// `vec3 paint(vec2 p, float t)`; a person's image is a texture. Either is put through the picked effect, tuned
// (light, blur, dim, a fade at the bottom), then eased under the reading limit (look.ts `readingLimit`): no pixel
// leaves the ink of the words on it under 4.5:1, whatever the picture and wherever a dial stands. The whole picture
// is eased, evenly, so its lights keep their order and nothing darkens in a patch behind the words.

import type { Rgb } from "./look.ts";
import type { Tiles } from "./swarm.ts";

/** What a painting's GLSL may call, and what it must define. Also the brief a painter works to (paintings.ts). */
export const PRELUDE = /* glsl */ `#version 300 es
precision highp float;

uniform float uAspect; // the box's width over its height
uniform vec3 uPanel;   // the page's own colour (sRGB), for a painting that sits in the theme
uniform vec2 uSize;    // the canvas, in its own pixels
uniform float uScale;  // canvas pixels a CSS px: uSize / uScale is the box in CSS px

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Value noise, 0 to 1.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Five octaves of it, 0 to 1.
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.02 + 17.3;
    a *= 0.5;
  }
  return v / 0.96875;
}
`;

const MAIN = /* glsl */ `
uniform float uTime;
uniform sampler2D uImage;
uniform vec2 uImageSize;   // 0 when the picture is a painting
uniform int uEffect;
uniform float uGrain;      // the effect's pattern, in CSS px
uniform float uAmount;
uniform float uBrightness;
uniform float uBlur;       // CSS px
uniform float uDim;
uniform float uFade;
uniform float uLimit;      // the luminance the picture is eased under (light ink) or over (dark ink)
uniform float uInkLight;   // 1: the words on it are light; 0: dark
out vec4 outColor;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// The person's image, cut to fill the box around its middle, blurred over a disc of taps.
vec3 image(vec2 px, vec2 box) {
  float fit = max(box.x / uImageSize.x, box.y / uImageSize.y);
  vec2 uv = ((px - 0.5 * box) / fit + 0.5 * uImageSize) / uImageSize;
  if (uBlur < 0.5) return texture(uImage, uv).rgb;
  float r = uBlur / fit;
  float lod = max(0.0, log2(r) - 1.0);
  vec3 c = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;
    c += textureLod(uImage, uv + vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 16.0) * r / uImageSize, lod).rgb;
  }
  return c / 16.0;
}

// The picture at a CSS px of the box, lit.
vec3 picture(vec2 px, vec2 box) {
  vec3 c = uImageSize.x > 0.0 ? image(px, box) : paint(vec2((px.x - 0.5 * box.x) / box.y, 0.5 - px.y / box.y), uTime);
  return clamp(c * uBrightness, 0.0, 1.0);
}

float bayer(vec2 cell) {
  ivec2 p = ivec2(mod(cell, 8.0));
  int v = 0;
  for (int i = 0; i < 3; i++) {
    int shift = 2 * (2 - i);
    v |= ((((p.x ^ p.y) >> i) & 1) << (shift + 1)) | (((p.y >> i) & 1) << shift);
  }
  return (float(v) + 0.5) / 64.0;
}

vec3 effect(vec2 px, vec2 box) {
  if (uEffect == 1) {
    // Dither: the picture in pixels of uGrain, each channel at one of uAmount steps, Bayer's matrix choosing between
    // two. The steps are counted from the panel's colour, so where the picture is the panel it stays flat.
    vec2 cell = floor(px / uGrain);
    vec3 c = picture((cell + 0.5) * uGrain, box);
    return uPanel + floor((c - uPanel) * uAmount + bayer(cell)) / uAmount;
  }
  if (uEffect == 2) {
    // Grain: two hashes summed, so most of it is slight and a little of it is not, as film is.
    vec2 cell = floor(px / uGrain);
    float n = hash21(cell + 0.37) + hash21(cell * 1.7 + 11.1) - 1.0;
    return picture(px, box) + n * uAmount * 0.16;
  }
  if (uEffect == 3) {
    // Reeded glass: each rib shows the picture from a little to one side, lit down its length, a seam between ribs.
    float f = fract(px.x / uGrain);
    vec3 c = picture(vec2(px.x + (f - 0.5) * uGrain * uAmount * 2.6, px.y), box);
    return c * (1.0 + uAmount * (0.12 * (0.5 - f) - 0.16 * smoothstep(0.07, 0.0, f)));
  }
  if (uEffect == 4) {
    // Dots: one lamp a cell in the picture's colour there, the board between them dark.
    vec2 cell = floor(px / uGrain);
    vec2 middle = (cell + 0.5) * uGrain;
    float r = uGrain * 0.36;
    float lamp = smoothstep(r + 0.6, r - 0.6, length(px - middle));
    return picture(middle, box) * mix(1.0 - uAmount, 1.0, lamp);
  }
  return picture(px, box);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) / uScale;
  vec2 box = uSize / uScale;
  vec3 c = clamp(effect(px, box), 0.0, 1.0);
  c = mix(c, uPanel, uDim);
  c = mix(c, uPanel, uFade > 0.0 ? smoothstep(1.0 - uFade, 1.0, px.y / box.y) : 0.0);

  // Eased toward the limit and never past it: a shoulder, as film has, so the brightest part is still the brightest.
  vec3 lin = toLinear(c);
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  if (uInkLight > 0.5) {
    lin *= uLimit * (1.0 - exp(-l / uLimit)) / max(l, 1e-5);
  } else {
    float room = 1.0 - uLimit;
    float dark = 1.0 - l;
    lin += (1.0 - lin) * (1.0 - room * (1.0 - exp(-dark / room)) / max(dark, 1e-5));
  }
  outColor = vec4(toSrgb(lin), 1.0);
}
`;

/** A person's image has no painting behind it. */
export const NO_PAINTING = "vec3 paint(vec2 p, float t) { return vec3(0.0); }";

const VERTEX = `#version 300 es
void main() {
  gl_Position = vec4(vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Everything a frame is drawn with. Lengths are CSS px; colours run 0 to 1. */
export interface Frame {
  readonly time: number;
  readonly effect: number;
  readonly grain: number;
  readonly amount: number;
  readonly brightness: number;
  readonly blur: number;
  readonly dim: number;
  readonly fade: number;
  readonly panel: Rgb;
  readonly limit: number;
  readonly inkLight: boolean;
}

export interface Renderer {
  /** The person's image; null for a painting. */
  setImage(image: TexImageSource | null, width?: number, height?: number): void;
  /** A living painting's tiles as they stand now (swarm.ts), for its GLSL to draw (tiles.ts). */
  setTiles(tiles: Tiles): void;
  /** The characters those tiles wear (tiles.ts `glyphAtlas`). */
  setGlyphs(atlas: TexImageSource): void;
  /** Draws a frame on the canvas as it is sized now. `scale`: canvas pixels a CSS px. */
  draw(frame: Frame, scale: number): void;
  /** Frees what it made on the canvas. `context`: the canvas is done with too, so its WebGL context goes now. */
  dispose(context?: boolean): void;
}

/** A renderer for one painting's GLSL on a canvas, or what went wrong: no WebGL2 here, or GLSL that does not compile. */
export function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  glsl: string,
): Renderer | { readonly error: string } {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    powerPreference: "low-power",
  }) as WebGL2RenderingContext | null;
  if (!gl) return { error: "WebGL2 is not available." };
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, `${PRELUDE}\n${glsl}\n${MAIN}`);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error =
      gl.getShaderInfoLog(fragment) || gl.getProgramInfoLog(program) || "The shader did not link.";
    gl.deleteProgram(program);
    return { error };
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = Object.fromEntries(
    [
      "uAspect",
      "uSize",
      "uScale",
      "uTime",
      "uImage",
      "uImageSize",
      "uEffect",
      "uGrain",
      "uAmount",
      "uBrightness",
      "uBlur",
      "uDim",
      "uFade",
      "uPanel",
      "uLimit",
      "uInkLight",
      "uTiles",
      "uGlyphs",
      "uLayers",
      "uGround",
    ].map((name) => [name, at(name)]),
  );
  const array = gl.createVertexArray();
  const texture = gl.createTexture();
  let imageSize: readonly [number, number] = [0, 0];
  // A living painting's two textures, made when it first hands them over.
  let tileTexture: WebGLTexture | null = null;
  let tileSize: readonly [number, number] = [0, 0];
  let glyphTexture: WebGLTexture | null = null;
  let layers = new Float32Array(12);
  let laid: Tiles["layers"] | null = null;
  let ground: Rgb = [0, 0, 0];

  return {
    setImage(image, width = 0, height = 0) {
      imageSize = image ? [width, height] : [0, 0];
      if (!image) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },
    setTiles(tiles) {
      const fresh = tileTexture === null;
      tileTexture ??= gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tileTexture);
      if (fresh) {
        // A texel is a tile, read whole: nothing between two of them is ever asked for.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      const { width, height, data } = tiles;
      // In place when it is the size it was.
      if (tileSize[0] === width && tileSize[1] === height)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      else
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      tileSize = [width, height];
      if (tiles.layers !== laid) layers = new Float32Array((laid = tiles.layers).flat());
      ground = tiles.ground;
    },
    setGlyphs(atlas) {
      glyphTexture ??= gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },
    draw(frame, scale) {
      const { width, height } = canvas;
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindVertexArray(array);
      if (tileTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tileTexture);
        gl.uniform1i(u.uTiles!, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
        gl.uniform1i(u.uGlyphs!, 2);
        gl.uniform4fv(u.uLayers!, layers);
        gl.uniform3f(u.uGround!, ...ground);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u.uImage!, 0);
      gl.uniform2f(u.uImageSize!, imageSize[0], imageSize[1]);
      gl.uniform1f(u.uAspect!, width / height);
      gl.uniform2f(u.uSize!, width, height);
      gl.uniform1f(u.uScale!, scale);
      gl.uniform1f(u.uTime!, frame.time);
      gl.uniform1i(u.uEffect!, frame.effect);
      gl.uniform1f(u.uGrain!, frame.grain);
      gl.uniform1f(u.uAmount!, frame.amount);
      gl.uniform1f(u.uBrightness!, frame.brightness);
      gl.uniform1f(u.uBlur!, frame.blur);
      gl.uniform1f(u.uDim!, frame.dim);
      gl.uniform1f(u.uFade!, frame.fade);
      gl.uniform3f(u.uPanel!, ...frame.panel);
      gl.uniform1f(u.uLimit!, frame.limit);
      gl.uniform1f(u.uInkLight!, frame.inkLight ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose(context = false) {
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      gl.deleteTexture(tileTexture);
      gl.deleteTexture(glyphTexture);
      gl.deleteVertexArray(array);
      if (context) gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
