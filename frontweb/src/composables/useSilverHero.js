import { onBeforeUnmount, ref } from 'vue'
import { EFFECT_LEVELS, fxEnabled, useEffects } from './useEffects'

/**
 * 液态银 hero —— 一片域扭曲的 fbm 高度场，按拉丝金属打光。
 *
 * 这是首页唯一一处「纯装饰但值得花显卡」的东西，所以它完全听效果档位的：
 * 完整档 5 个八度、1.35 倍分辨率、40 帧；均衡档 4 个八度、24 帧；
 * 轻量及以下不渲染（canvas 留空，底下露出渐变底色，视觉上不掉档）。
 * 切档位会重建 shader，而不是让旧的画质赖在那不动。
 */

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;
uniform float u_live;
uniform float u_stretch;   // 画布越扁，这个越小：把噪声域横向压回来，
                           // 让金属纹理顺着宽横幅的方向拉长成拉丝，而不是糊成泡沫
uniform vec3  u_base;
uniform vec3  u_chrome;
uniform vec3  u_safelight;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.,0.)), u.x),
             mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), u.x), u.y);
}
// 八度数由质量档位决定；替换锚在循环那一行，注释里出现同名 token 也不会被误替换。
float fbm(vec2 p){
  float v = 0., a = .5;
  for (int i = 0; i < OCTAVE_COUNT; i++){ v += a * noise(p); p = p * 2.02 + vec2(.31, .17); a *= .5; }
  return v;
}
float height(vec2 uv){
  float t = u_time * (.045 + u_live * .16);
  vec2 q = uv * vec2(u_stretch, 1.0) * 1.55;
  vec2 w = vec2(fbm(q + vec2(0., t)), fbm(q + vec2(5.2, -t * .8)));
  float h = fbm(q + 1.9 * w + vec2(t * .5, 0.));
  float rip = sin((uv.y + h * .55) * 26.0 - t * 5.0) * .5 + .5;
  return h * .82 + rip * .18 * (.35 + u_live * .65);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - .5 * u_res) / min(u_res.x, u_res.y);
  uv += (u_mouse - .5) * .22;

  float h  = height(uv);
  vec2  e  = vec2(.0032, 0.);
  float hx = height(uv + e.xy) - height(uv - e.xy);
  float hy = height(uv + e.yx) - height(uv - e.yx);
  vec3  n  = normalize(vec3(-hx, -hy, .54));

  vec3  eye = normalize(vec3(uv, 1.05));
  vec3  L   = normalize(vec3(-.45 + (u_mouse.x - .5) * .9, .62 + (u_mouse.y - .5) * .5, .78));
  float dif = clamp(dot(n, L), 0., 1.);
  float spe = pow(clamp(dot(reflect(-L, n), eye), 0., 1.), 42.0);
  float fre = pow(1.0 - clamp(dot(n, eye), 0., 1.), 3.2);

  float brush = smoothstep(0., .16, abs(hx) * 7.0);
  vec3  metal = mix(u_chrome * .48, u_chrome, brush);

  vec3 col = u_base * (1.0 - h * .55);
  col += metal * (dif * .62 + spe * 1.5);
  col += u_chrome * fre * .5;

  float rim = smoothstep(1.05, .18, length(uv - vec2(.62, -.5)));
  col += u_safelight * pow(rim, 3.4) * (.1 + u_live * .3);

  float vig = smoothstep(1.55, .28, length(uv));
  col *= mix(.34, 1.06, vig);
  col += (hash(gl_FragCoord.xy + u_time) - .5) * .022;

  col = pow(max(col, 0.), vec3(.86));
  gl_FragColor = vec4(col, 1.);
}`

const hex = (s) => s.match(/\w\w/g).map((x) => parseInt(x, 16) / 255)

/** 档位 → shader 开销。关掉时返回 null，调用方直接不建 context。 */
export function heroQualityFor(levelId) {
  if (levelId === 'high') return { octaves: 5, maxDpr: 1.35, fps: 40 }
  if (levelId === 'balanced') return { octaves: 4, maxDpr: 1, fps: 24 }
  return null
}

/**
 * 把一片 canvas 变成液态银。返回一个 stop()。
 * canvas 为 null、WebGL 不可用或档位太低时，返回的 stop 是个空操作。
 */
export function paintSilver(canvas, { live = 0.5, octaves = 4, maxDpr = 1, fps = 24, animate = true } = {}) {
  if (!canvas) return () => {}
  const gl = canvas.getContext('webgl', { antialias: false, alpha: true, powerPreference: 'low-power' })
  if (!gl) return () => {}   // 没有 WebGL 就留空，hero 底下的渐变照旧好看

  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null }
    return s
  }
  const src = FRAG.replaceAll('OCTAVE_COUNT', String(Math.max(1, Math.min(5, octaves))))
  const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, src)
  if (!vs || !fs) return () => {}

  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const U = (n) => gl.getUniformLocation(prog, n)
  const u = { res: U('u_res'), time: U('u_time'), mouse: U('u_mouse'), live: U('u_live'), stretch: U('u_stretch'), base: U('u_base'), chrome: U('u_chrome'), safe: U('u_safelight') }

  gl.uniform3fv(u.base, hex('14171c'))
  gl.uniform3fv(u.chrome, hex('c8ced8'))
  gl.uniform3fv(u.safe, hex('f2a23a'))

  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
  const minFrame = 1000 / Math.max(1, fps)
  let mouse = [.5, .42], target = [.5, .42], raf = 0
  const t0 = performance.now()
  let last = 0
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const still = reduce || !animate

  function resize() {
    const r = canvas.getBoundingClientRect()
    const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h)
      return true
    }
    return false
  }
  function draw(now) {
    gl.uniform2f(u.res, canvas.width, canvas.height)
    gl.uniform1f(u.time, still ? 6 : (now - t0) / 1000)
    gl.uniform2fv(u.mouse, mouse)
    gl.uniform1f(u.live, live)
    // 1:1 时保持原样；越扁越压横向频率（平方根，避免扁过头变成条纹）
    const aspect = Math.max(1, canvas.width / Math.max(1, canvas.height))
    gl.uniform1f(u.stretch, Math.min(1, Math.max(.28, Math.sqrt(1.9 / aspect))))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  function frame(now) {
    const resized = resize()
    mouse[0] += (target[0] - mouse[0]) * .05
    mouse[1] += (target[1] - mouse[1]) * .05
    // 固定节奏重绘：这是氛围，不是游戏引擎。静止时只在真的还在移动才画。
    const moving = Math.abs(target[0] - mouse[0]) > .0015 || Math.abs(target[1] - mouse[1]) > .0015
    if (now - last >= minFrame || resized) {
      if (!still || moving || resized || last === 0) { draw(now); last = now }
    }
    raf = requestAnimationFrame(frame)
  }
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect()
    target = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]
  }
  const onLeave = () => { target = [.5, .42] }
  window.addEventListener('pointermove', onMove, { passive: true })
  canvas.addEventListener('pointerleave', onLeave)

  // 离屏就停手，别在看不见的地方烧显卡
  let io = null
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting
      if (visible && animate && !raf) { last = 0; raf = requestAnimationFrame(frame) }
      else if (visible && !animate) { resize(); draw(performance.now()) }
      else if (!visible && raf) { cancelAnimationFrame(raf); raf = 0 }
    }, { threshold: .01 })
    io.observe(canvas)
  } else if (animate) {
    raf = requestAnimationFrame(frame)
  }

  return () => {
    cancelAnimationFrame(raf); raf = 0
    io?.disconnect()
    window.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerleave', onLeave)
    // 切档仍复用同一个 canvas；主动丢失 context 会让下一档拿到失效的上下文。
    gl.useProgram(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.deleteBuffer(buf)
    gl.deleteProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
  }
}

/**
 * 组合式用法：给 hero 一个 template ref，档位一变就按新画质重建。
 * 用法：const { heroCanvas, live } = useSilverHero()
 */
export function useSilverHero() {
  const heroCanvas = ref(null)
  const live = ref(0.5)
  let stop = () => {}

  function arm() {
    const level = useEffects().level.value
    stop()
    stop = () => {}
    const quality = heroQualityFor(level)
    // 最低档连 context 都不建：手机和旧显卡上这一片就是干净底色
    if (!quality || !fxEnabled('decor')) return
    stop = paintSilver(heroCanvas.value, { live: live.value, animate: fxEnabled('anim'), ...quality })
  }

  function onLevel() { arm() }

  function mount() {
    arm()
    window.addEventListener('yinzi:effects-changed', onLevel)
  }
  function unmount() {
    window.removeEventListener('yinzi:effects-changed', onLevel)
    stop(); stop = () => {}
  }
  onBeforeUnmount(unmount)

  return { heroCanvas, live, mount, unmount, levels: EFFECT_LEVELS }
}
