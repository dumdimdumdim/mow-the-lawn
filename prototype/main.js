// Прототип «срез газона»: общая маска скошенной площади, две поверхности,
// неровный силуэт кромки и боковина среза; тень — карта проекции геометрии.
// three.js r170, ортографическая камера почти сверху.
import * as THREE from 'three';

// GLSL/three ошибки рендера уходили только в console.error и терялись:
// теперь они видны в window.__errs вместе с JS-ошибками
const _consoleError = console.error.bind(console);
console.error = (...a) => {
  (window.__errs ||= []).push(a.map(String).join(' ').slice(0, 300));
  _consoleError(...a);
};

// ---------- константы мира ----------
const LAWN_W = 26, LAWN_D = 18;          // метры, x ∈ [-13,13], z ∈ [-9,9]
const PPM = 64;                          // пикселей маски на метр
const MASK_W = LAWN_W * PPM, MASK_H = LAWN_D * PPM;
const TALL_H = 0.035;                    // высота травы, м
const BLADE_W = 0.56;                    // ширина ножа, м
// вынос ножа: передняя кромка отпечатка (BLADE_OFF + BLADE_W/2) должна оставаться
// под декой (её передний край на +0.37), иначе срез выступает кругом впереди машинки
const BLADE_OFF = 0.07;
const MAX_SPEED = 2.3, REV_SPEED = -0.9;
const TURN_RATE = 1.55;                  // рад/с на полном ходу
const GUIDE_SPACING = BLADE_W - 0.04;    // соседние проходы перекрываются на 4 см или больше
const GUIDE_ANGLE = Math.PI / 18;        // подхват в пределах 10° от прямого курса
const GUIDE_RELEASE = 0.18;              // короткая пауза после ручного поворота
const START = { x: -5, z: 6, heading: Math.PI }; // лицом в -z (вверх экрана)
// Нескошенной полосы вдоль забора нет: нож достаёт до самой кромки газона,
// поэтому знаменатель прогресса — весь газон (углы скруглены вылетом ножа).
const BORDER = 0.0;
const MOW_HX = LAWN_W / 2 - BORDER, MOW_HZ = LAWN_D / 2 - BORDER;
const BLADE_REACH = BLADE_OFF + BLADE_W / 2;              // 0.35 м вылет ножа
const CTR_HX = MOW_HX - BLADE_REACH, CTR_HZ = MOW_HZ - BLADE_REACH;
// габариты: манекен в 1.02 м позади центра косилки, радиус фигуры 0.30 м;
// внутренняя грань штакетника на LAWN/2 + 0.42
const CHAR_BACK = 1.02, CHAR_R = 0.30;
// непрерывные пределы центра: минимум из вылета ножа (кромка + круглый конец штампа)
// и выноса манекена до внутренней грани штакетника; без скачков при смене курса
const BLADE_CTR_HX = MOW_HX - BLADE_W / 2, BLADE_CTR_HZ = MOW_HZ - BLADE_W / 2;
const CHAR_CTR_HX = LAWN_W / 2 + 0.42 - CHAR_R, CHAR_CTR_HZ = LAWN_D / 2 + 0.42 - CHAR_R;

// солнце: единый фиксированный источник, ~48° над горизонтом → тень ≈ рост,
// уходит вбок (-x, +z), в силуэте читаются голова, плечи и наклон к ручке
const SUN = new THREE.Vector3(-0.55, 0.72, 0.55).normalize();

// ---------- рендерер / сцена / камера ----------
// stencil:true — буфер трафарета нужен, чтобы тень фигуры ЗАМЕНЯЛА гребёнку
// в перекрытии (без двойного multiply-затемнения), см. fenceShadow/figureShadow
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
const COARSE = matchMedia('(pointer:coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfdefb1);

let viewHalfH = 5.6;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
// рыскание 45°: обе пары сторон забора видны под равным углом (иначе боковые
// штакетины сжаты в 3-px пунктир внутри зелёной ленты тени); ромб газона как на постере
const CAM_YAW = 45 * Math.PI / 180;
const CAM_OFF = new THREE.Vector3(Math.sin(CAM_YAW) * 8.1, 13, Math.cos(CAM_YAW) * 8.1); // наклон ~32° от вертикали
const grassPixelWorld = { value: 0 };
// Поправка на укорочение земли по вертикали экрана из-за наклона камеры.
const groundTowardCamera = new THREE.Vector2(Math.sin(CAM_YAW), Math.cos(CAM_YAW))
  .multiplyScalar(CAM_OFF.length() / CAM_OFF.y);
const groundScreenRight = new THREE.Vector2(Math.cos(CAM_YAW), -Math.sin(CAM_YAW));
const camTarget = new THREE.Vector3(START.x, 0, START.z);
let camOverride = null;

function layoutCamera() {
  const a = innerWidth / innerHeight;
  camera.left = -viewHalfH * a; camera.right = viewHalfH * a;
  camera.top = viewHalfH; camera.bottom = -viewHalfH;
  camera.updateProjectionMatrix();
  grassPixelWorld.value = 2 * viewHalfH / innerHeight;
}
layoutCamera();

scene.add(new THREE.HemisphereLight(0xfff3d6, 0x4a7a33, 1.15));
const sunLight = new THREE.DirectionalLight(0xffe6b8, 1.6);
sunLight.position.copy(SUN).multiplyScalar(30);
scene.add(sunLight);

// ---------- маска скошенной площади ----------
const maskCanvas = document.createElement('canvas');
maskCanvas.width = MASK_W; maskCanvas.height = MASK_H;
const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
const maskTex = new THREE.CanvasTexture(maskCanvas);
maskTex.minFilter = THREE.LinearFilter;
maskTex.magFilter = THREE.LinearFilter;
maskTex.generateMipmaps = false;
maskTex.wrapS = maskTex.wrapT = THREE.ClampToEdgeWrapping;

function worldToMask(x, z) { return [(x + LAWN_W / 2) * PPM, (z + LAWN_D / 2) * PPM]; }

function makeWildflowerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_W;
  canvas.height = MASK_H;
  const ctx = canvas.getContext('2d');

  // Один и тот же разброс при загрузке и после сброса газона.
  let seed = 929;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const groups = [];
  for (let attempt = 0; attempt < 90 && groups.length < 26; attempt++) {
    const x = (random() - 0.5) * (LAWN_W - 1.6);
    const z = (random() - 0.5) * (LAWN_D - 1.6);
    if (groups.some(([gx, gz]) => Math.hypot(x - gx, z - gz) < 1.8)) continue;
    groups.push([x, z]);

    const yellow = random() < 0.26;
    const count = 2 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const spread = Math.sqrt(random()) * 0.34;
      const [px, py] = worldToMask(x + Math.cos(angle) * spread, z + Math.sin(angle) * spread);
      const size = 0.73 + random() * 0.52;
      const lean = (random() - 0.5) * 4.5;
      const stem = 4 + random() * 3;

      ctx.strokeStyle = '#68852d';
      ctx.lineWidth = 1.05 * size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px + lean, py + stem);
      ctx.quadraticCurveTo(px + lean * 0.9, py + stem * 0.45, px, py);
      ctx.moveTo(px + lean * 0.7, py + stem * 0.58);
      ctx.lineTo(px + lean * 0.7 + Math.cos(angle) * 2.7, py + stem * 0.30);
      ctx.stroke();

      ctx.fillStyle = yellow ? '#efc849' : '#f6efc7';
      ctx.beginPath();
      for (let petal = 0; petal < 5; petal++) {
        const turn = angle + petal * Math.PI * 2 / 5;
        const cx = px + Math.cos(turn) * 1.42 * size;
        const cy = py + Math.sin(turn) * 1.42 * size;
        ctx.moveTo(cx + 1.04 * size, cy);
        ctx.arc(cx, cy, 1.04 * size, 0, Math.PI * 2);
      }
      ctx.fill();

      ctx.fillStyle = yellow ? '#ac7f24' : '#d7a632';
      ctx.beginPath();
      ctx.arc(px, py, 0.85 * size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.premultiplyAlpha = true;
  return texture;
}

function clearMask() {
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, MASK_W, MASK_H);
  maskTex.needsUpdate = true;
}
let lastStamp = null;
function stampBlade(x0, z0, x1, z1) {
  lastStamp = { x0, z0, x1, z1 };
  const [a, b] = worldToMask(x0, z0);
  const [c, d] = worldToMask(x1, z1);
  mctx.strokeStyle = '#fff';
  mctx.lineWidth = BLADE_W * PPM;
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';
  mctx.beginPath();
  mctx.moveTo(a, b);
  mctx.lineTo(c, d);
  mctx.stroke();
  maskTex.needsUpdate = true;
}

// ---------- шейдер газона ----------

// ---------- карта теней: проекция реальной геометрии на землю ----------
// Один фиксированный источник; манекен, косилка и кроны деревьев рендерятся
// в ортографическую карту со стороны солнца, шейдер газона проецирует её обратно.
const SHADOW_RES = 1024;
const shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES);
shadowRT.texture.minFilter = THREE.NearestFilter;
shadowRT.texture.magFilter = THREE.NearestFilter;
shadowRT.texture.generateMipmaps = false;
const shadowCam = new THREE.OrthographicCamera(-9, 9, 7, -7, 1, 90);
// камера тени следует за игроком: тот же 1024² на меньшей площади = чётче край
shadowCam.position.copy(SUN).multiplyScalar(45);
shadowCam.lookAt(0, 0, 0);
shadowCam.updateMatrixWorld();
shadowCam.updateProjectionMatrix();
shadowCam.layers.set(1);          // в карту теней идут только кастеры (слой 1)
// основная камера остаётся на слое 0: кроны деревьев (только слой 1) в кадре не видны
const shOverride = new THREE.MeshBasicMaterial({ color: 0x000000 });
const shadowMat4 = new THREE.Matrix4()
  .multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);

const groundUniforms = {
  uMask: { value: maskTex },
  uWildflowers: { value: makeWildflowerTexture() },
  uTallH: { value: TALL_H },
  uGrassPixelWorld: grassPixelWorld,
  uGroundTowardCamera: { value: groundTowardCamera },
  uGroundScreenRight: { value: groundScreenRight },
  uShadow: { value: shadowRT.texture },
  uShadowMat: { value: shadowMat4 },
};

const groundMat = new THREE.ShaderMaterial({
  uniforms: groundUniforms,
  vertexShader: /* glsl */`
    uniform sampler2D uMask;
    uniform float uTallH;
    varying vec2 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 tx = vec2(${(1 / MASK_W).toFixed(8)}, ${(1 / MASK_H).toFixed(8)});
      float m = texture2D(uMask, uv).r * 0.36;
      m += texture2D(uMask, uv + vec2(tx.x * 2.0, 0.0)).r * 0.16;
      m += texture2D(uMask, uv - vec2(tx.x * 2.0, 0.0)).r * 0.16;
      m += texture2D(uMask, uv + vec2(0.0, tx.y * 2.0)).r * 0.16;
      m += texture2D(uMask, uv - vec2(0.0, tx.y * 2.0)).r * 0.16;
      wp.y += uTallH * (1.0 - smoothstep(0.15, 0.85, m));
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMask;
    uniform sampler2D uWildflowers;
    uniform sampler2D uShadow;
    uniform mat4 uShadowMat;
    uniform float uGrassPixelWorld;
    uniform vec2 uGroundTowardCamera;
    uniform vec2 uGroundScreenRight;
    varying vec2 vUv;
    varying vec3 vWorld;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float grassNoise(vec2 p) {
      vec2 cell = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), f.x),
        mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }
    float grassDensity(vec2 world) {
      // Крупный рисунок задаёт плотность мелких вкраплений.
      // У сгущений нет собственной границы: к краям вкрапления редеют.
      vec2 p = mat2(0.94, -0.34, 0.34, 0.94) * world;
      float field = 0.64 * grassNoise(p * vec2(0.56, 0.81) + vec2(5.3, 2.7))
                  + 0.36 * grassNoise(p * vec2(1.9, 2.6) + vec2(9.1, 4.7));
      float density = smoothstep(0.52, 0.81, field);

      vec2 detail = p * vec2(19.0, 31.0);
      float grain = grassNoise(detail + vec2(2.9, 7.3));
      float threshold = mix(0.91, 0.56, density);
      float edge = clamp(fwidth(grain), 0.03, 0.20);
      float stipple = smoothstep(threshold - edge, threshold + edge, grain);
      float resolved = 1.0 - smoothstep(0.40, 0.95, length(fwidth(detail)));
      return mix(density * 0.40, stipple, resolved) * density;
    }
    float maskAt(vec2 uv) {
      vec2 tx = vec2(${(1 / MASK_W).toFixed(8)}, ${(1 / MASK_H).toFixed(8)});
      float s = texture2D(uMask, uv).r * 0.4;
      s += texture2D(uMask, uv + vec2(tx.x, 0.0)).r * 0.15;
      s += texture2D(uMask, uv - vec2(tx.x, 0.0)).r * 0.15;
      s += texture2D(uMask, uv + vec2(0.0, tx.y)).r * 0.15;
      s += texture2D(uMask, uv - vec2(0.0, tx.y)).r * 0.15;
      return s;
    }
    float mowAt(vec2 uv) {
      return smoothstep(0.45, 0.55, maskAt(uv));
    }
    float fringeAt(vec2 uv, vec2 world, float mowed) {
      if (mowed >= 0.5) return 0.0;

      // Дальний край: под травинкой, по направлению к камере, должен быть покос.
      // UV земли переворачивает Z, поэтому шаг в её осях имеет обратный знак по V.
      vec2 down = uGroundTowardCamera * uGrassPixelWorld;
      vec2 downUv = down / vec2(${LAWN_W}.0, -${LAWN_D}.0);
      float bottom = 4.5;
      vec2 below = uv + downUv * bottom;
      if (any(lessThan(below, vec2(0.0))) || any(greaterThan(below, vec2(1.0)))) return 0.0;
      if (texture2D(uMask, below).r < 0.5) return 0.0;

      float top = 0.0;
      for (int i = 0; i < 4; i++) {
        float mid = 0.5 * (top + bottom);
        if (texture2D(uMask, uv + downUv * mid).r < 0.5) top = mid;
        else bottom = mid;
      }
      float aboveRoot = 0.5 * (top + bottom);
      vec2 root = world + down * aboveRoot;

      // Случайный разброс закреплён в мире. Шумом по поверхности собираем
      // травинки в короткие пучки и оставляем просветы между ними.
      const float spacing = 0.037;
      float lane = dot(world, uGroundScreenRight) / spacing;
      float id = floor(lane);
      float chance = hash21(vec2(id, 5.7));
      float clump = smoothstep(0.36, 0.67, grassNoise(root * 4.3 + vec2(7.1, 2.2)));
      if (chance > mix(0.03, 0.98, clump * clump)) return 0.0;

      float height = mix(2.0, 4.0, hash21(vec2(id, 17.4)));
      float t = clamp(aboveRoot / height, 0.0, 1.0);
      float center = mix(0.31, 0.69, hash21(vec2(id, 37.2)));
      float bend = (hash21(vec2(id, 9.8)) - 0.5) * 1.70 * t * t;
      float dx = (fract(lane) - center) * spacing / uGrassPixelWorld - bend;
      float taper = mix(0.65, 0.23, t);
      float stroke = 1.0 - smoothstep(max(0.0, taper - 0.30), taper + 0.30, abs(dx));
      return stroke * (1.0 - smoothstep(height - 0.45, height + 0.30, aboveRoot));
    }
    void main() {
      // Две базовые плашки с общим рисунком плотности, который ослабевает после покоса.
      float mowed = mowAt(vUv);
      vec3 tall = vec3(0.573, 0.682, 0.180);   // #92ae2e
      vec3 cut  = vec3(0.714, 0.812, 0.204);   // #b6cf34
      vec3 col = mix(tall, cut, mowed);
      float density = grassDensity(vWorld.xz);
      // вкрапления — участки более густой травы: контраст на треть ниже прежнего,
      // на покосе исчезают целиком (1.0 - mowed), размер и распределение не менялись
      col -= vec3(0.086, 0.072, 0.009) * density * (1.0 - mowed);

      // жёсткая одноцветная тень из карты проекции геометрии (1 tap, без PCF)
      vec4 sp = uShadowMat * vec4(vWorld, 1.0);
      vec2 suv = sp.xy * 0.5 + 0.5;
      float sh = 0.0;
      if (suv.x > 0.002 && suv.x < 0.998 && suv.y > 0.002 && suv.y < 0.998) {
        sh = 1.0 - texture2D(uShadow, suv).r;
      }
      col = mix(col, vec3(0.161, 0.467, 0.173), sh);   // #29772c
      col *= 1.0 - vec3(0.32, 0.25, 0.34) * fringeAt(vUv, vWorld.xz, mowed);

      vec4 flowers = texture2D(uWildflowers, vUv);
      vec3 flowerLight = mix(vec3(1.0), vec3(0.49, 0.62, 0.42), sh);
      col += (flowers.rgb * flowerLight - col * flowers.a) * (1.0 - mowed);

      // печатное зерно: мелкое world-space зерно на ВСЕЙ траве (скошенной и нет),
      // стабильно при движении камеры; плюс едва заметный экранный шум печати
      float printGrain = grassNoise(vWorld.xz * 70.0 + vec2(1.7, 9.2));
      col += (printGrain - 0.5) * 0.055;
      col += (hash21(gl_FragCoord.xy) - 0.5) * 0.02;

      gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);
      #include <colorspace_fragment>
    }`,
});

const groundGeo = new THREE.PlaneGeometry(LAWN_W, LAWN_D, 640, 448);
groundGeo.rotateX(-Math.PI / 2);
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.frustumCulled = false;
scene.add(ground);

// ---------- материалы ----------
// двухступенчатый cel-shading (плашечный постер)
const gradTex = new THREE.DataTexture(new Uint8Array([120, 255]), 2, 1, THREE.RedFormat);
gradTex.minFilter = gradTex.magFilter = THREE.NearestFilter;
gradTex.needsUpdate = true;
const toon = hex => new THREE.MeshToonMaterial({ color: hex, gradientMap: gradTex });
const matShirt = toon(0xfcb715);
const matPants = toon(0xfef4b9);
const matSkin = toon(0xecc485);
const matInk = toon(0x101407);
const matRed = toon(0xcf472a);
const matRedDark = toon(0xb03a22);
const matWhite = toon(0xfef4b9);
const matFence = new THREE.MeshBasicMaterial({ color: 0xfcf9c3 }); // плоская заливка без света, как на постере
// чёрный контур: inverted hull, выдавливание по нормали В МИРОВЫХ единицах
// (локальное выдавливание съедается масштабом конечностей)
const matOutline = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  vertexShader: /* glsl */`
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      wp.xyz += normalize(mat3(modelMatrix) * normal) * 0.012;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    void main() {
      gl_FragColor = vec4(pow(vec3(0.063, 0.078, 0.027), vec3(2.2)), 1.0);
      #include <colorspace_fragment>
    }`,
});
function outlined(mesh) { mesh.add(new THREE.Mesh(mesh.geometry, matOutline)); return mesh; }

function roundedBoxGeo(w, h, d, r) {
  const shape = new THREE.Shape();
  const x = w / 2 - r, y = d / 2 - r;
  shape.absarc(x, y, r, 0, Math.PI / 2);
  shape.absarc(-x, y, r, Math.PI / 2, Math.PI);
  shape.absarc(-x, -y, r, Math.PI, Math.PI * 1.5);
  shape.absarc(x, -y, r, Math.PI * 1.5, Math.PI * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r,
    bevelSegments: 3, curveSegments: 8,
  });
  g.rotateX(Math.PI / 2); // shape XY → горизонталь, выдавливание вниз
  g.translate(0, h / 2 - r, 0);
  return g;
}

// ---------- косилка ----------
const mowerRoot = new THREE.Group();
scene.add(mowerRoot);

const deck = new THREE.Mesh(roundedBoxGeo(0.56, 0.17, 0.74, 0.06), matRed);
deck.position.y = 0.16;
mowerRoot.add(outlined(deck));
const deckTop = new THREE.Mesh(roundedBoxGeo(0.44, 0.06, 0.56, 0.05), matRedDark);
deckTop.position.y = 0.255;
mowerRoot.add(outlined(deckTop));
const underside = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.66), matInk);
underside.position.y = 0.095;
mowerRoot.add(outlined(underside));
// чёрный цилиндрический двигатель, как на постере
const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.15, 14), matInk);
engine.position.set(0, 0.33, -0.10);
mowerRoot.add(outlined(engine));

const wheelGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.055, 16);
wheelGeo.rotateZ(Math.PI / 2);
const wheels = [];
for (const [wx, wz] of [[-0.315, -0.24], [0.315, -0.24], [-0.315, 0.24], [0.315, 0.24]]) {
  const w = new THREE.Mesh(wheelGeo, matWhite);
  w.position.set(wx, 0.095, wz);
  mowerRoot.add(outlined(w)); wheels.push(w);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 10), matInk);
  hub.rotation.z = Math.PI / 2;
  hub.position.set(wx, 0.095, wz);
  mowerRoot.add(hub);
}

function tubeBetween(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}
const gripL = new THREE.Vector3(-0.20, 0.95, -0.68);
const gripR = new THREE.Vector3(0.20, 0.95, -0.68);
mowerRoot.add(outlined(tubeBetween(new THREE.Vector3(-0.20, 0.26, -0.30), gripL, 0.022, matInk)));
mowerRoot.add(outlined(tubeBetween(new THREE.Vector3(0.20, 0.26, -0.30), gripR, 0.022, matInk)));
mowerRoot.add(outlined(tubeBetween(new THREE.Vector3(-0.24, 0.95, -0.68), new THREE.Vector3(0.24, 0.95, -0.68), 0.02, matInk)));
for (const gx of [-0.20, 0.20]) {
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.13, 10), matInk);
  grip.rotation.z = Math.PI / 2;
  grip.position.set(gx, 0.95, -0.68);
  mowerRoot.add(grip);
}

// ---------- манекен ----------
const charGroup = new THREE.Group();
charGroup.position.set(0, 0, -1.02);
mowerRoot.add(charGroup);

function ball(r, sx = 1, sy = 1, sz = 1, mat = matPants) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), mat);
  m.scale.set(sx, sy, sz);
  return outlined(m);
}
function capsule(r, len, mat = matPants) {
  return outlined(new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat));
}

const pelvis = ball(0.15, 1.15, 0.75, 0.95); pelvis.position.set(0, 0.92, 0);
const torso = capsule(0.155, 0.30, matShirt); torso.position.set(0, 1.18, 0.02); torso.rotation.x = 0.12;
const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 12), matSkin);
neck.position.set(0, 1.42, 0.05);
const head = ball(0.115, 0.95, 1.05, 1.0, matSkin); head.position.set(0, 1.56, 0.07);
// шапка тёмных волос: сфера чуть больше головы, сдвинута вверх-назад, лицо остаётся skin
const hair = ball(0.121, 1.0, 0.85, 1.0, matInk); hair.position.set(0, 1.60, 0.045);
charGroup.add(pelvis, torso, outlined(neck), head, hair);

// плечевые шары утоплены в торс (радиус торса 0.155): центр на ±0.14,
// наружу выступает лишь шапка плеча. БЕЗ обводки: контурный шар читался
// как отдельный шарик на палке; теперь плечо сливается с силуэтом торса
const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 16), matShirt);
shoulderL.position.set(-0.14, 1.35, 0.03);
const shoulderR = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 16), matShirt);
shoulderR.position.set(0.14, 1.35, 0.03);
charGroup.add(shoulderL, shoulderR);

// ноги: бедро (группа у таза) → колено → голень → стопа
function buildLeg(side) {
  const hip = new THREE.Group();
  hip.position.set(0.095 * side, 0.88, 0);
  const hipBall = ball(0.085); hip.add(hipBall);
  // звенья под 2-bone IK: бедро→колено 0.46, колено→лодыжка 0.42, лодыжка→подошва 0.03
  const thigh = capsule(0.065, 0.34); thigh.position.y = -0.23; hip.add(thigh);
  const knee = new THREE.Group(); knee.position.y = -0.46; hip.add(knee);
  knee.add(ball(0.07));
  const shin = capsule(0.055, 0.32); shin.position.y = -0.21; knee.add(shin);
  const foot = new THREE.Mesh(roundedBoxGeo(0.09, 0.06, 0.21, 0.025), matInk);
  foot.position.set(0, -0.42, 0.05); knee.add(outlined(foot));
  charGroup.add(hip);
  return { hip, knee, foot };
}
const legL = buildLeg(-1), legR = buildLeg(1);

// руки: 2-bone IK плечо→локоть→кисть с ФИКСИРОВАННЫМИ длинами звеньев;
// кисть всегда на грипе, недосягаемость разруливается сдвигом фигуры (ensureArmReach)
const upperArmL = capsule(0.055, 0.24, matShirt), foreArmL = capsule(0.05, 0.22, matShirt);
const upperArmR = capsule(0.055, 0.24, matShirt), foreArmR = capsule(0.05, 0.22, matShirt);
const elbowL = ball(0.06, 1, 1, 1, matShirt), elbowR = ball(0.06, 1, 1, 1, matShirt);
const handL = ball(0.065, 0.9, 1.1, 0.9, matSkin), handR = ball(0.065, 0.9, 1.1, 0.9, matSkin);
charGroup.add(upperArmL, foreArmL, elbowL, handL, upperArmR, foreArmR, elbowR, handR);

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
function placeLimb(mesh, a, b, nominal) {
  _d.subVectors(b, a);
  const len = _d.length();
  mesh.position.copy(a).addScaledVector(_d, 0.5);
  mesh.scale.set(1, len / nominal, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _d.normalize());
}
const ARM_U = 0.34, ARM_F = 0.32;      // фиксированные звенья: плечо→локоть, локоть→кисть
const _ap = new THREE.Vector3(), _ae = new THREE.Vector3();
function buildArm(side, upper, fore, elbow, hand, shoulder, grip) {
  // в локальных координатах манекена; grip задан в координатах косилки
  _a.copy(shoulder.position);
  // грип из координат косилки в координаты манекена с учётом поворота фигуры
  const gy = charGroup.rotation.y, cg = Math.cos(gy), sg = Math.sin(gy);
  const gx = grip.x - charGroup.position.x, gz = grip.z - charGroup.position.z;
  _b.set(gx * cg - gz * sg, grip.y - charGroup.position.y, gx * sg + gz * cg);
  // 2-bone IK: длины звеньев не меняются, локоть по полюсу сгиба наружу-вниз-назад
  _d.subVectors(_b, _a);
  const d = THREE.MathUtils.clamp(_d.length(), Math.abs(ARM_U - ARM_F) + 1e-4, ARM_U + ARM_F - 1e-4);
  _d.normalize();
  const a = (ARM_U * ARM_U - ARM_F * ARM_F + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(ARM_U * ARM_U - a * a, 0));
  _ap.set(side, -0.45, -0.55).addScaledVector(_d, -_ap.dot(_d));
  if (_ap.lengthSq() < 1e-8) _ap.set(side, 0, 0);
  _ap.normalize();
  _ae.copy(_a).addScaledVector(_d, a).addScaledVector(_ap, h);
  elbow.position.copy(_ae);
  hand.position.copy(_b);              // кисть точно на грипе
  placeLimb(upper, _a, _ae, ARM_U);    // scale = 1: звено номинальной длины
  placeLimb(fore, _ae, _b, ARM_F);
}
// досягаемость: если грип дальше ARM_U+ARM_F, сдвигаем фигуру к грипу
// (мировой сдвиг → локальные координаты косилки) и перерешаем IK ног —
// звенья рук не растягиваются никогда
const _rs = new THREE.Vector3(), _rg = new THREE.Vector3(), _rd = new THREE.Vector3();
function ensureArmReach() {
  const reach = ARM_U + ARM_F;
  let over = 0;
  for (const [sh, gr] of [[shoulderL, gripL], [shoulderR, gripR]]) {
    _rs.copy(sh.position); charGroup.localToWorld(_rs);
    _rg.copy(gr); mowerRoot.localToWorld(_rg);
    const D = _rs.distanceTo(_rg);
    if (D - reach > over) { over = D - reach; _rd.subVectors(_rg, _rs).normalize(); }
  }
  if (over > 0) {
    const c = Math.cos(state.heading), s = Math.sin(state.heading), k = over + 0.005;
    charGroup.position.x += (_rd.x * c - _rd.z * s) * k;
    charGroup.position.y += _rd.y * k;
    charGroup.position.z += (_rd.x * s + _rd.z * c) * k;
    charGroup.updateMatrixWorld(true);
    solveLegIK(legL, -1, gait.feet[0]);
    solveLegIK(legR, 1, gait.feet[1]);
  }
}

// ---------- поза фигуры: походка stance/swing и разворот на месте ----------
// Разворот на месте крутит heading самой косилки (позиция не меняется).
// Фигура всегда позади рукоятки (CHAR_BACK по heading) и в мире идёт по дуге
// радиуса CHAR_BACK вокруг центра косилки; руки остаются на грипе.
const PIVOT_RATE = 1.2;                // рад/с разворота косилки на месте
const HIP_Y = 0.88;                    // высота бедра в локальных координатах фигуры
const THIGH_L = 0.46, SHIN_L = 0.42;   // звенья IK: бедро→колено, колено→лодыжка
const LEG_REACH = THIGH_L + SHIN_L;
const ANKLE_H = 0.03, ANKLE_OFF = 0.05; // лодыжка выше подошвы и позади центра стопы
const HIP_BASE = 0.90;                 // высота бедра стоя (лёгкий естественный сгиб)
// хорда бедро→лодыжка ограничена 98.5% досягаемости: опорное колено всегда
// согнуто ~20°, а не выпрямлено в струну (100%) и не поджато (90% = присед)
const HIP_REACH = LEG_REACH * 0.985;
// idle relax: после паузы IDLE_DELAY обе стопы идут под бёдра с ограниченной
// скоростью (без телепорта), носки доворачиваются к pose.angle, торс вертикален
const IDLE_DELAY = 0.15;               // пауза покоя перед началом relax, с
const IDLE_SPEED = 1.0;                // м/с — предел скорости стоп по XZ
const IDLE_VY = 0.45;                  // м/с — предел опускания подошвы
const IDLE_YAW_RATE = 6.0;             // рад/с — доворот носков к курсу фигуры
const IDLE_AHEAD = 0.02;               // вынос стоп вперёд от бедра, м

const pose = {
  mode: 'follow',                      // фигура всегда позади рукоятки
  beta: 0,                             // совместимость с хуком gait (орбиты больше нет)
  localX: 0, localZ: -CHAR_BACK,       // позиция фигуры в координатах косилки
  angle: START.heading,                // мировой рыск фигуры (отдельно от heading)
};

function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function smooth01(t) { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t); }
// длина шага согласована со скоростью; на повороте шаги короче (разворот стоп)
function stepLenFor(v, yawRate) {
  return THREE.MathUtils.clamp(0.34 + 0.19 * v, 0.30, 0.72)
       * THREE.MathUtils.clamp(1 - 0.22 * Math.abs(yawRate), 0.5, 1);
}
function charWorldXZ() {
  const h = state.heading, c = Math.cos(h), s = Math.sin(h);
  return [state.x + pose.localX * c + pose.localZ * s,
          state.z - pose.localX * s + pose.localZ * c];
}
function hipWorldXZ(side) {
  const [cx, cz] = charWorldXZ();
  const a = pose.angle + gait.twist;             // таз повёрнут вместе с торсом
  const c = Math.cos(a), s = Math.sin(a);
  return [cx + 0.095 * side * c, cz - 0.095 * side * s];
}

// походка: опорная стопа фиксирована в мире (y=0, XZ не скользит), маховая
// идёт по дуге; фаза набегает от пути фигуры, полуцикл = один шаг длиной L
const gait = {
  phase: 0, steps: 0, L: 0.5, charSpeed: 0, yawRate: 0,
  settle: 1, settled: true, lastDist: 0, inited: false,
  idleTime: 0, relaxing: false, relaxT: 0,
  dir: new THREE.Vector3(Math.sin(START.heading), 0, Math.cos(START.heading)),
  prev: new THREE.Vector3(), prevAngle: START.heading,
  feet: [0, 1].map(() => ({
    sole: new THREE.Vector3(), yaw: START.heading, mode: 'stance',
    from: new THREE.Vector3(), fromYaw: START.heading,
  })),
};

function reinitGait() {
  const [cx, cz] = charWorldXZ();
  gait.phase = 0; gait.steps = 0; gait.L = 0.5;
  gait.settle = 1; gait.settled = true; gait.charSpeed = 0; gait.yawRate = 0;
  gait.idleTime = 0; gait.relaxing = false; gait.relaxT = 0;
  gait.dir.set(Math.sin(pose.angle), 0, Math.cos(pose.angle));
  gait.prev.set(cx, 0, cz); gait.prevAngle = pose.angle;
  for (const side of [-1, 1]) {
    const f = gait.feet[side < 0 ? 0 : 1];
    const [hx, hz] = hipWorldXZ(side);
    const ahead = side < 0 ? 0.06 : -0.06;
    f.sole.set(hx + gait.dir.x * ahead, 0, hz + gait.dir.z * ahead);
    f.yaw = pose.angle; f.mode = side < 0 ? 'stance' : 'swing';
    f.from.copy(f.sole); f.fromYaw = f.yaw;
  }
  gait.inited = true;
}
// сброс/телепорт: стопы не должны тянуться из старых мировых точек
function gaitGuard() {
  if (!gait.inited) reinitGait();
  else if (state.distance === 0 && state.speed === 0 && gait.lastDist !== 0) reinitGait();
}

function updatePose(dt) {
  // фигура жёстко позади рукоятки: разворот косилки (в т.ч. на месте) несёт
  // её по дуге вокруг центра; походку ведёт updateGait по мировому пути фигуры
  pose.localX = 0; pose.localZ = -CHAR_BACK; pose.angle = state.heading;
}

const _gv = new THREE.Vector3(), _gt = new THREE.Vector3();
// ── Походка из готовых CC0-клипов (Quaternius UAL2, assets/motion/clips.json) ──
// Траектории извлечены офлайн (FK по rest-позе GLB): стопа относительно бедра
// в системе таза, высота подошвы и yaw. Опорная стопа, как и в процедурной
// ветке, фиксируется в мире; маховая дуга, темп и точка посадки — из клипа.
// Пока clips.json не загружен (или fetch упал) — процедурный фолбэк ниже.
const CLIP = { data: null, gen: null, old: null, snap: null, blend: 1, bob: 0 };
fetch(new URL('assets/motion/clips.json', import.meta.url))
  .then(r => r.json()).then(j => { CLIP.data = j.clips; })
  .catch(() => { CLIP.data = null; });

function clipSample(clip, t) {
  const fr = clip.frames, dur = clip.dur;
  let u = t % dur; if (u < 0) u += dur;
  let i = 0;
  while (i < fr.length - 2 && fr[i + 1].t < u) i++;
  const a = fr[i], b = fr[i + 1];
  const f = THREE.MathUtils.clamp((u - a.t) / ((b.t - a.t) || 1), 0, 1);
  const L = (x, y) => x + (y - x) * f;
  const LA = (x, y) => x + normAngle(y - x) * f;   // yaw по короткой дуге
  const py = L(a.pelvis[3], b.pelvis[3]);
  const ca = Math.cos(-py), sa = Math.sin(-py);
  const out = { bob: L(a.pelvis[1], b.pelvis[1]) - clip.pelvisRestY, feet: [] };
  for (const s of ['l', 'r']) {
    const A = a['foot_' + s], B = b['foot_' + s];
    const TA = a['thigh_' + s], TB = b['thigh_' + s];
    const dx = L(A[0], B[0]) - L(TA[0], TB[0]);
    const dz = L(A[2], B[2]) - L(TA[1], TB[1]);
    out.feet.push({
      bx: ca * dx + sa * dz, bz: -sa * dx + ca * dz,
      sole: L(A[1], B[1]) - clip.ankleRest,
      // rest-ориентация кости стопы развёрнута на π относительно таза —
      // без вычета носки смотрят назад (по clips.json yawRel ≈ ±3.13).
      // Кламп ±0.35 рад: собственный разворот стопы в клипе доходит до ±0.8
      // (задний ход, мах) — визуально «ступня на 90 градусов» относительно тела.
      yawRel: THREE.MathUtils.clamp(normAngle(LA(A[3], B[3]) - py - Math.PI), -0.35, 0.35),
    });
  }
  return out;
}

function clipGait(dt, v, yawRate) {
  gait.pivotOn = state.speed === 0 && Math.abs(yawRate) > 0.4;
  // назад — клип заднего хода (направление зашито в клип, стопы в системе
  // корпуса); вперёд и дуга разворота — клип переднего хода в системе курса
  const back = state.speed < -0.02;   // v — модуль скорости фигуры, знак даёт state.speed
  const clipName = back ? 'walk_bwd_loop' : 'walk_fwd_loop';
  const clip = CLIP.data[clipName];
  const native = Math.hypot(clip.travel[0], clip.travel[1]);   // перенос за цикл (2 шага)
  const kL = THREE.MathUtils.clamp(stepLenFor(v, yawRate) / (native / 2), 0.45, 1.15);
  const kY = THREE.MathUtils.clamp(kL, 0.6, 1) * 0.55;   // подъём стопы: клип UAL2 шагает высоко (0.26 м), гасим до бытовой походки
  const rate = Math.abs(v) / (native * kL);                    // циклов/с = скорость фигуры
  if (!CLIP.gen || CLIP.gen.clip !== clip) {
    CLIP.old = CLIP.gen;
    if (!CLIP.old) CLIP.snap = gait.feet.map(f => ({ x: f.sole.x, y: f.sole.y, z: f.sole.z, yaw: f.yaw, swing: f.mode === 'swing' }));
    CLIP.blend = 0;
    CLIP.gen = { clip, name: clipName, t: 0, rate, kL, kY };
  }
  const g = CLIP.gen;
  g.rate = rate; g.kL = kL; g.kY = kY;
  g.t += rate * dt * g.clip.dur;   // rate — циклов/с, g.t — секунды клипа
  if (CLIP.old) CLIP.old.t += CLIP.old.rate * dt * CLIP.old.clip.dur;
  CLIP.blend = Math.min(1, CLIP.blend + dt / 0.3);
  const e = smooth01(CLIP.blend);
  if (CLIP.blend >= 1) { CLIP.old = null; CLIP.snap = null; }
  // Позиции шага — по курсу движения (хорда скорости), ориентация стоп — по
  // ТОРСУ (pose.angle + twist): хорда отстаёт от heading на повороте, и стопы
  // смотрели вбок относительно тела до ~90° («ступни периодически на 90
  // градусов»). Если крутить и позиции по торсу — «ножницы» стоп на дуге.
  const wa = back ? pose.angle : Math.atan2(gait.dir.x, gait.dir.z);
  const waYaw = back ? pose.angle : pose.angle + gait.twist;
  const ca = Math.cos(wa), sa = Math.sin(wa);
  // на развороте стойка чуть шире: дуга орбиты сносит опорную стопу к средней линии
  const wide = gait.pivotOn ? 0.02 : 0;
  const smp = clipSample(g.clip, g.t);
  CLIP.bob = smp.bob * g.kY;
  const oldSmp = CLIP.old ? clipSample(CLIP.old.clip, CLIP.old.t) : null;
  const target = (sm, gg, i) => {
    const ft = sm.feet[i];
    const [hx, hz] = hipWorldXZ(i === 0 ? -1 : 1);
    const bx = ft.bx * gg.kL + (i === 0 ? -1 : 1) * wide, bz = ft.bz * gg.kL;
    return { x: hx + ca * bx + sa * bz, z: hz - sa * bx + ca * bz,
             y: Math.max(0, ft.sole * gg.kY), yaw: waYaw + ft.yawRel, swing: ft.sole > 0.05 };
    // порог 0.05: в клипе опорная стопа к концу стойки отрывает пятку (sole до
    // ~0.03) — ниже порога это всё ещё опора, иначе world-lock срывается
  };
  for (let i = 0; i < 2; i++) {
    const f = gait.feet[i];
    let t1 = target(smp, g, i);
    if (e < 1) {
      const t0 = oldSmp ? target(oldSmp, CLIP.old, i) : CLIP.snap[i];
      t1 = { x: t0.x + (t1.x - t0.x) * e, z: t0.z + (t1.z - t0.z) * e,
             y: t0.y + (t1.y - t0.y) * e, yaw: t0.yaw + normAngle(t1.yaw - t0.yaw) * e,
             swing: e > 0.5 ? t1.swing : t0.swing };
    }
    const wasStance = f.mode === 'stance';
    if (!t1.swing && wasStance && e >= 1) {
      f.mode = 'stance';                       // world-lock опорной стопы
      // на развороте опорная стопа доворачивается на месте вместе с торсом
      // (шаг-пивот на носке), иначе носок отстаёт от тела на угол дуги за шаг
      if (gait.pivotOn) f.yaw = waYaw;
    } else {
      if (wasStance && t1.swing) gait.steps++;  // отрыв = новый полушаг
      f.sole.set(t1.x, t1.y, t1.z);
      f.yaw = t1.yaw;
      f.mode = t1.swing ? 'swing' : 'stance';
    }
  }
  gait.phase = (g.t / g.clip.dur) * Math.PI * 2 % (Math.PI * 2);
}

function updateGait(dt) {
  gaitGuard();
  gait.lastDist = state.distance;
  const [cx, cz] = charWorldXZ();
  _gv.set(cx - gait.prev.x, 0, cz - gait.prev.z);
  const jump = _gv.length();
  if (jump > 0.5) { reinitGait(); return; }   // телепорт: переставляем стопы заново
  const v = jump / Math.max(dt, 1e-6);
  gait.charSpeed = v;
  gait.yawRate = normAngle(pose.angle - gait.prevAngle) / Math.max(dt, 1e-6);
  if (v > 1e-4) _gt.copy(_gv).normalize(); else _gt.copy(gait.dir);
  gait.dir.lerp(_gt, Math.min(1, dt * 12)).normalize();

  // покой: после паузы ~0.15 с обе стопы плавно идут под бёдра (idle relax);
  // при возврате в движение шаговый цикл стартует от текущих стоп — без рывка
  if (v < 0.02) {
    gait.idleTime += dt;
    gait.settle = Math.min(1, gait.settle + dt * 5);
    if (gait.idleTime >= IDLE_DELAY && !gait.relaxing) {
      gait.relaxing = true; gait.relaxT = 0; gait.settled = false;
      // выход из relax обратно в клип-походку будет через бленд от текущих стоп
      CLIP.gen = null; CLIP.old = null; CLIP.snap = null; CLIP.blend = 1; CLIP.bob = 0;
    }
  } else {
    gait.idleTime = 0;
    gait.settle = Math.max(0, gait.settle - dt * 8);
    gait.settled = false;
    if (gait.relaxing) {
      gait.relaxing = false; gait.relaxT = 0;
      const o = gait.feet[1 - (gait.steps % 2)];
      o.from.copy(o.sole); o.fromYaw = o.yaw;
      gait.phase = 0;
    }
  }

  if (gait.relaxing) {
    // relax: скорость стоп ограничена (≤0.05 м за 0.05 с), сходимость монотонная;
    // маховая дуга не пересчитывается, чтобы не перебивать плавное опускание
    gait.relaxT += dt;
    const ramp = smooth01(Math.min(1, gait.relaxT / 0.08));
    const fx = Math.sin(pose.angle), fz = Math.cos(pose.angle);
    let done = true;
    for (const side of [-1, 1]) {
      const f = gait.feet[side < 0 ? 0 : 1];
      const [hx, hz] = hipWorldXZ(side);
      const tx = hx + fx * IDLE_AHEAD, tz = hz + fz * IDLE_AHEAD;
      const dx = tx - f.sole.x, dz = tz - f.sole.z;
      const dist = Math.hypot(dx, dz);
      const mv = Math.min(dist, IDLE_SPEED * ramp * dt);
      if (dist > 1e-9) { f.sole.x += dx / dist * mv; f.sole.z += dz / dist * mv; }
      f.sole.y = Math.max(0, f.sole.y - IDLE_VY * ramp * dt);
      const dy = normAngle(pose.angle - f.yaw);
      const my = IDLE_YAW_RATE * ramp * dt;
      f.yaw = Math.abs(dy) <= my ? pose.angle : f.yaw + Math.sign(dy) * my;
      f.mode = 'stance';
      if (dist - mv > 1e-5 || f.sole.y > 0 || f.yaw !== pose.angle) done = false;
    }
    if (done && !gait.settled) {
      gait.phase = 0;
      const o = gait.feet[1 - (gait.steps % 2)];
      o.from.copy(o.sole); o.fromYaw = o.yaw;
      gait.settled = true;
    }
  } else if (CLIP.data) {
    clipGait(dt, v, gait.yawRate);
  } else {
    // Обычная чередующаяся походка вдоль направления движения (в т.ч. на
    // развороте: верх тела довёрнут к движению applyTwist, поэтому стопы шагают
    // «вперёд» относительно торса, а не ножницами поперёк тела). Посадка —
    // своё бедро + dir*L/2: опорная стопа не уезжает за среднюю линию торса.
    gait.phase += v * dt * Math.PI / gait.L;
    // на развороте стойка чуть шире (люди расширяют базу при повороте) —
    // компенсует боковой снос опорной стопы за счёт вращения дуги
    const wide = (state.speed < 0.05 && Math.abs(gait.yawRate) > 0.4) ? 0.02 : 0;
    const ta = pose.angle + gait.twist;          // «своя сторона» в системе торса
    const rx = Math.cos(ta), rz = -Math.sin(ta);
    if (gait.phase >= Math.PI) {
      gait.phase -= Math.PI;
      gait.steps++;
      const si = gait.steps % 2;                 // новая опорная нога
      const f = gait.feet[si], o = gait.feet[1 - si];
      const [hx, hz] = hipWorldXZ(si === 0 ? -1 : 1);
      const sw = (si === 0 ? -1 : 1) * wide;
      // посадка точно туда, куда шла маховая (L прошлого шага) — без рывка
      f.sole.set(hx + gait.dir.x * gait.L / 2 + rx * sw, 0, hz + gait.dir.z * gait.L / 2 + rz * sw);
      f.yaw = Math.atan2(gait.dir.x, gait.dir.z);
      f.mode = 'stance';
      o.mode = 'swing'; o.from.copy(o.sole); o.fromYaw = o.yaw;
      gait.L = stepLenFor(v, gait.yawRate);      // длина следующего шага
    }
    // маховая нога: дуга от старой опоры к будущей; цель сходится к точке посадки
    const oi = 1 - (gait.steps % 2), o = gait.feet[oi];
    const s = gait.phase / Math.PI, e = smooth01(s);
    const [ohx, ohz] = hipWorldXZ(oi === 0 ? -1 : 1);
    const reach = gait.L * (1 - s) + gait.L / 2;
    const ow = (oi === 0 ? -1 : 1) * wide;
    _gt.set(ohx + gait.dir.x * reach + rx * ow, 0, ohz + gait.dir.z * reach + rz * ow);
    o.sole.lerpVectors(o.from, _gt, e);
    o.sole.y = (0.045 + 0.05 * Math.min(v / MAX_SPEED, 1)) * Math.sin(Math.PI * s);
    o.yaw = o.fromYaw + normAngle(Math.atan2(gait.dir.x, gait.dir.z) - o.fromYaw) * e;
    gait.feet[gait.steps % 2].mode = 'stance';
    o.mode = 'swing';
    // на развороте опорная стопа доворачивается на месте вместе с торсом
    // (шаг-пивот на носке), иначе носок отстаёт от тела на угол дуги за шаг
    if (state.speed < 0.05 && Math.abs(gait.yawRate) > 0.4) {
      gait.feet[gait.steps % 2].yaw = Math.atan2(gait.dir.x, gait.dir.z);
    }
  }
  gait.prev.set(cx, 0, cz); gait.prevAngle = pose.angle;
}

// 2-bone IK бедра к стопе (аналог placeLimb для рук): колено гнётся вперёд фигуры
const _ih = new THREE.Vector3(), _ia = new THREE.Vector3(), _ik = new THREE.Vector3();
const _id = new THREE.Vector3(), _ip = new THREE.Vector3(), _io = new THREE.Vector3();
const _iq = new THREE.Quaternion(), _iq2 = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0), _downY = new THREE.Vector3(0, -1, 0);
function solveLegIK(leg, side, f) {
  // лодыжка в мире: над подошвой, чуть позади центра стопы; затем в координаты фигуры
  _ia.set(f.sole.x - Math.sin(f.yaw) * ANKLE_OFF, f.sole.y + ANKLE_H,
          f.sole.z - Math.cos(f.yaw) * ANKLE_OFF);
  charGroup.worldToLocal(_ia);
  _ih.set(0.095 * side, HIP_Y, 0);
  _id.subVectors(_ia, _ih);
  const d = THREE.MathUtils.clamp(_id.length(), Math.abs(THIGH_L - SHIN_L) + 1e-3, LEG_REACH - 1e-3);
  _id.normalize();
  const a = (THIGH_L * THIGH_L - SHIN_L * SHIN_L + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(THIGH_L * THIGH_L - a * a, 0));
  _ip.set(0, 0, 1).addScaledVector(_id, -_id.z);   // полюс сгиба = локальный +z фигуры
  if (_ip.lengthSq() < 1e-8) _ip.set(1, 0, 0);
  _ip.normalize();
  _ik.copy(_ih).addScaledVector(_id, a).addScaledVector(_ip, h);
  _io.subVectors(_ik, _ih).normalize();
  leg.hip.quaternion.setFromUnitVectors(_downY, _io);
  _iq.copy(leg.hip.quaternion).invert();
  _io.subVectors(_ia, _ik).normalize().applyQuaternion(_iq);
  leg.knee.quaternion.setFromUnitVectors(_downY, _io);
  // стопа — ребёнок КОЛЕНА: её position = (цель стопы − колено) в системе
  // колена. Раньше сюда писался offset лодыжки (~3 см) — стопа рисовалась
  // в 3 см под коленом («ступни застряли на коленях»).
  _iq.copy(leg.hip.quaternion).multiply(leg.knee.quaternion).invert();
  _io.set(f.sole.x, f.sole.y + 0.03, f.sole.z);   // центр стопы: подошва на sole.y
  charGroup.worldToLocal(_io);
  _io.sub(_ik).applyQuaternion(_iq);
  leg.foot.position.copy(_io);
  // Мировая ориентация стопы = f.yaw. Компенсировать нужно ВСЮ мировую цепку
  // (mowerRoot.heading + charGroup.rotation.y + бедро + колено): раньше гасился
  // только локальный charGroup.rotation.y, и на повороте меш стопы отставал от
  // цели на величину heading — «ступни периодически на 90 градусов».
  leg.knee.updateWorldMatrix(true, false);
  leg.knee.getWorldQuaternion(_iq).invert();
  _iq2.setFromAxisAngle(_yAxis, f.yaw);
  leg.foot.quaternion.copy(_iq).multiply(_iq2);
}

// на развороте всё тело (таз, ноги, торс, голова) доворачивается к направлению
// движения: руки остаются на грипе (IK), а ноги шагают «вперёд» относительно
// тела как при обычной ходьбе — без «ножниц» стоп поперёк корпуса
gait.twist = 0;
function applyTwist(dt) {
  const pivoting = state.speed < 0.05 && Math.abs(gait.yawRate) > 0.4;
  const want = pivoting
    ? THREE.MathUtils.clamp(normAngle(Math.atan2(gait.dir.x, gait.dir.z) - pose.angle), -1.45, 1.45)
    : 0;
  gait.twist += (want - gait.twist) * Math.min(1, dt * 10);
}

// поза фигуры целиком: таз опускается ровно настолько, чтобы IK доставала до стоп
function poseFigure() {
  gaitGuard();
  let hipH = HIP_BASE;
  // в шаге хорда ограничена 98.5% досягаемости (сгиб ~20°); стоя — полная,
  // чтобы idle-поза не приседала
  const reachEff = gait.on ? HIP_REACH : LEG_REACH;
  for (const side of [-1, 1]) {
    const f = gait.feet[side < 0 ? 0 : 1];
    const [hx, hz] = hipWorldXZ(side);
    const dH = Math.hypot(f.sole.x - Math.sin(f.yaw) * ANKLE_OFF - hx,
                          f.sole.z - Math.cos(f.yaw) * ANKLE_OFF - hz);
    hipH = Math.min(hipH, f.sole.y + ANKLE_H + Math.sqrt(Math.max(reachEff * reachEff - dH * dH, 0.04)));
  }
  // вертикальный bob таза из клипа (клип-походка); в relax — прежний hipH
  const clipBob = (CLIP.gen && !gait.relaxing) ? CLIP.bob : 0;
  // без нижнего порога: таз ровно на hipH (порог 0.45 задирал фигуру и
  // выпрямлял ноги в струну — хорда бедро→стопа превышала LEG_REACH)
  charGroup.position.set(pose.localX, hipH - HIP_Y + clipBob, pose.localZ);
  charGroup.rotation.y = normAngle(pose.angle - state.heading + gait.twist);
  // idle-фактор: после паузы покоя торс плавно выпрямляется (плечи опускаются),
  // при движении наклон возвращается за ~0.3 с — без рывка
  const idle = smooth01(THREE.MathUtils.clamp((gait.idleTime - IDLE_DELAY) / 0.30, 0, 1));
  torso.rotation.x = (0.12 + Math.min(gait.charSpeed / MAX_SPEED, 1) * 0.04) * (1 - idle);
  mowerRoot.updateMatrixWorld(true);
  solveLegIK(legL, -1, gait.feet[0]);
  solveLegIK(legR, 1, gait.feet[1]);
}

// ---------- состояние и физика ----------
const state = {
  x: START.x, z: START.z, heading: START.heading,
  speed: 0, walkPhase: 0, distance: 0,
};
const keys = { up: false, down: false, left: false, right: false };
let prevBlade = null;
let mowGuide = null;
let guidePause = 0;

function bladePos() {
  return [state.x + Math.sin(state.heading) * BLADE_OFF,
          state.z + Math.cos(state.heading) * BLADE_OFF];
}
function stampHere() {
  const [bx, bz] = bladePos();
  stampBlade(bx, bz, bx, bz);
  prevBlade = [bx, bz];
}
function reset() {
  state.x = START.x; state.z = START.z; state.heading = START.heading;
  state.speed = 0; state.walkPhase = 0; state.distance = 0;
  mowGuide = null; guidePause = 0;
  clearMask();
  prevBlade = null;   // первый срез появится только после первого движения
  syncVisuals(0);
  updateProgress(true);
}

function updateMowGuide(dt) {
  if (keys.left || keys.right) {
    mowGuide = null;
    guidePause = GUIDE_RELEASE;
    return;
  }
  guidePause = Math.max(0, guidePause - dt);
  const speed = Math.abs(state.speed);
  if (guidePause > 0 || speed < 0.14 || (!keys.up && !keys.down)) return;

  if (!mowGuide) {
    const quarterTurn = Math.PI / 2;
    const cardinal = Math.round(state.heading / quarterTurn);
    const heading = cardinal * quarterTurn;
    if (Math.abs(heading - state.heading) > GUIDE_ANGLE) return;

    const alongZ = cardinal % 2 === 0;
    const axis = alongZ ? 'x' : 'z';
    const limit = alongZ ? BLADE_CTR_HX : BLADE_CTR_HZ;
    const origin = START[axis];
    const edge = state[axis] >= origin ? limit : -limit;

    // Делим отрезок от стартовой полосы до края. Крайняя направляющая
    // проходит там, где нож достаёт до границы газона.
    const span = Math.abs(edge - origin);
    const spacing = span / Math.ceil(span / GUIDE_SPACING);
    const lane = origin + Math.round((state[axis] - origin) / spacing) * spacing;
    const side = alongZ ? Math.cos(heading) : -Math.sin(heading);
    mowGuide = { heading, axis, side, lane: THREE.MathUtils.clamp(lane, -limit, limit) };
  }

  // Подруливаем к линии через курс, поэтому косилка заходит на неё по дуге.
  // Задний ход меняет знак поправки, а сама линия остаётся той же.
  const { heading, axis, side, lane } = mowGuide;
  const offset = (lane - state[axis]) * side * Math.sign(state.speed);
  const lookAhead = Math.max(0.75, speed * 0.55);
  const approach = THREE.MathUtils.clamp(Math.atan2(offset, lookAhead), -GUIDE_ANGLE, GUIDE_ANGLE);
  const turn = (heading + approach - state.heading) * (1 - Math.exp(-8 * dt));
  state.heading += THREE.MathUtils.clamp(turn, -0.9 * dt, 0.9 * dt);
}

function physicsStep(dt) {
  const target = keys.up ? MAX_SPEED : (keys.down ? REV_SPEED : 0);
  const acc = target > state.speed ? 2.8 : 4.2;
  state.speed += THREE.MathUtils.clamp(target - state.speed, -acc * dt, acc * dt);
  if (!keys.up && !keys.down && Math.abs(state.speed) < 0.02) state.speed = 0;

  const steer = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
  // разворот на месте: без up/down и на стоянке косилка крутит heading на месте
  // (позиция не меняется), фигура позади рукоятки идёт по дуге вокруг центра
  const pivotNow = !keys.up && !keys.down && state.speed === 0 && steer !== 0;
  if (pivotNow) {
    state.heading += steer * PIVOT_RATE * dt;
  } else {
    const sf = 0.35 + 0.65 * Math.min(Math.abs(state.speed) / MAX_SPEED, 1);
    state.heading += steer * TURN_RATE * sf * dt * Math.sign(state.speed || 1);
  }
  updateMowGuide(dt);

  const dx = Math.sin(state.heading) * state.speed * dt;
  const dz = Math.cos(state.heading) * state.speed * dt;
  // кламп по габаритам: непрерывный минимум вылета ножа и выноса манекена,
  // чтобы и косилка, и фигура оставались по свою сторону штакетника на любом курсе
  const sx = Math.sin(state.heading), cz = Math.cos(state.heading);
  const limXp = Math.min(BLADE_CTR_HX - BLADE_OFF * sx, CHAR_CTR_HX + CHAR_BACK * sx);
  const limXn = Math.min(BLADE_CTR_HX + BLADE_OFF * sx, CHAR_CTR_HX - CHAR_BACK * sx);
  const limZp = Math.min(BLADE_CTR_HZ - BLADE_OFF * cz, CHAR_CTR_HZ + CHAR_BACK * cz);
  const limZn = Math.min(BLADE_CTR_HZ + BLADE_OFF * cz, CHAR_CTR_HZ - CHAR_BACK * cz);
  state.x = THREE.MathUtils.clamp(state.x + dx, -limXn, limXp);
  state.z = THREE.MathUtils.clamp(state.z + dz, -limZn, limZp);

  const [bx, bz] = bladePos();
  if (!prevBlade) {
    if (state.speed !== 0) stampHere();
  } else if (bx !== prevBlade[0] || bz !== prevBlade[1]) {
    stampBlade(prevBlade[0], prevBlade[1], bx, bz);
  }
  prevBlade = [bx, bz];

  updatePose(dt);
  updateGait(dt);
  state.walkPhase = gait.phase;
  state.distance += Math.abs(state.speed) * dt;
}

// ---------- визуальное обновление ----------
const _w = new THREE.Vector3();
function worldOf(obj) { return obj.getWorldPosition(_w.clone()); }

function syncVisuals(dt) {
  mowerRoot.position.set(state.x, 0, state.z);
  mowerRoot.rotation.y = state.heading;

  // фигура: походка stance/swing + 2-bone IK ног (мировые стопы из gait)
  applyTwist(dt);
  poseFigure();
  ensureArmReach();                    // грип недосягаем → сдвиг фигуры, не растяжение рук
  buildArm(-1, upperArmL, foreArmL, elbowL, handL, shoulderL, gripL);
  buildArm(1, upperArmR, foreArmR, elbowR, handR, shoulderR, gripR);

  for (const w of wheels) w.rotation.x += state.speed * dt / 0.095;

  updateFigureShadow();   // силуэт тени пересобирается из текущей позы

  // камера: цель клампим у кромки газона, чтобы в кадр попадали
  // штакетник и тротуар — пространство вокруг луга, как на постере
  const limX = LAWN_W / 2 - 1.0;
  const limZ = LAWN_D / 2 - 1.0;
  const tx = camOverride ? camOverride.x : THREE.MathUtils.clamp(state.x, -limX, limX);
  const tz = camOverride ? camOverride.z : THREE.MathUtils.clamp(state.z, -limZ, limZ);
  const k = camOverride ? 1 : 1 - Math.exp(-4 * Math.max(dt, 1e-4));
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.z += (tz - camTarget.z) * k;
  camera.position.copy(camTarget).add(CAM_OFF);
  camera.lookAt(camTarget);
}

// ---------- тротуар и штакетник (плашечный периметр постера) ----------
// плоская заливка + жёсткая бирюзовая тень + зерно; не кастер (layer 0)
function flatMat(hex, shHex) {
  const c = new THREE.Color(hex).convertLinearToSRGB();
  const s = new THREE.Color(shHex).convertLinearToSRGB();
  return new THREE.ShaderMaterial({
    uniforms: {
      uShadow: groundUniforms.uShadow,
      uShadowMat: groundUniforms.uShadowMat,
      uCol: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uSh: { value: new THREE.Vector3(s.r, s.g, s.b) },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uShadow;
      uniform mat4 uShadowMat;
      uniform vec3 uCol;
      uniform vec3 uSh;
      varying vec3 vWorld;
      float hash21(vec2 p) {
        p = fract(p * vec2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }
      void main() {
        vec4 sp = uShadowMat * vec4(vWorld, 1.0);
        vec2 suv = sp.xy * 0.5 + 0.5;
        float sh = 0.0;
        if (suv.x > 0.002 && suv.x < 0.998 && suv.y > 0.002 && suv.y < 0.998)
          sh = 1.0 - texture2D(uShadow, suv).r;
        vec3 col = mix(uCol, uSh, sh);
        col += (hash21(gl_FragCoord.xy) - 0.5) * 0.03;
        gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
const sidewalk = new THREE.Mesh(new THREE.PlaneGeometry(70, 50), flatMat(0xfdefb1, 0x5b9686));
sidewalk.rotation.x = -Math.PI / 2;
sidewalk.position.y = -0.03;
scene.add(sidewalk);
// тонкие швы тротуара
for (const [w, d, x, z] of [[70, 0.06, 0, 12.5], [70, 0.06, 0, -12.5], [0.06, 50, 17, 0], [0.06, 50, -17, 0]]) {
  const seam = new THREE.Mesh(new THREE.PlaneGeometry(w, d), flatMat(0xe8d795, 0x5b9686));
  seam.rotation.x = -Math.PI / 2;
  seam.position.set(x, -0.02, z);
  scene.add(seam);
}
// штакетник с заострёнными верхушками: один InstancedMesh по периметру
const picketShape = new THREE.Shape();
picketShape.moveTo(-0.07, 0);
picketShape.lineTo(0.07, 0);
picketShape.lineTo(0.07, 0.72);
picketShape.lineTo(0, 0.86);
picketShape.lineTo(-0.07, 0.72);
picketShape.closePath();
const picketGeo = new THREE.ExtrudeGeometry(picketShape, { depth: 0.045, bevelEnabled: false });
picketGeo.translate(0, 0, -0.0225);
const FX = LAWN_W / 2 + 0.45, FZ = LAWN_D / 2 + 0.45;
const picketPos = [];
for (let x = -FX; x <= FX + 0.001; x += 0.24) { picketPos.push([x, FZ, 0]); picketPos.push([x, -FZ, 0]); }
for (let z = -FZ + 0.24; z <= FZ - 0.24 + 0.001; z += 0.24) { picketPos.push([FX, z, Math.PI / 2]); picketPos.push([-FX, z, Math.PI / 2]); }
const fence = new THREE.InstancedMesh(picketGeo, matFence, picketPos.length);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
picketPos.forEach(([x, z, ry], i) => {
  _e.set(0, ry, 0); _q.setFromEuler(_e); _v.set(x, 0, z);
  _m4.compose(_v, _q, _s);
  fence.setMatrixAt(i, _m4);
});
fence.instanceMatrix.needsUpdate = true;
fence.position.y = -0.03;
// тень штакетника — статический шейп ниже; в карту тени забор не рендерим
scene.add(fence);
// две рейки на каждую сторону
const fenceRails = new THREE.Group();
for (const y of [0.25, 0.6]) {
  for (const sz of [FZ, -FZ]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(FX * 2 + 0.14, 0.07, 0.05), matFence);
    rail.position.set(0, y, sz); fenceRails.add(rail);
  }
  for (const sx of [FX, -FX]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, FZ * 2 + 0.14), matFence);
    rail.position.set(sx, y, 0); fenceRails.add(rail);
  }
}
fenceRails.position.y = -0.03;
scene.add(fenceRails);

// ---------- тень штакетника: статический шейп вместо прохода тени ----------
// Силуэт каждой штакетины, сдвинутый по направлению тени (-SUN.xz/SUN.y на высоту).
// Один merged-меш = 1 draw call; забор и рейки больше не участвуют в проходе тени.
// Multiply-затемнение подложки (не плашка): результат = dst * mix(1, tint, alpha).
// Цвета сразу в sRGB (кадровый буфер sRGB-кодирован), без colorspace_fragment.
const SH_TINT = new THREE.Vector3(0.25, 0.69, 0.62); // зелёный tint мультипликации
const SH_ALPHA = 0.75;                               // сила затемнения ~0.7–0.8
const shBlend = {
  transparent: true,
  blending: THREE.CustomBlending,
  blendSrc: THREE.DstColorFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquation: THREE.AddEquation,
  depthTest: true, depthWrite: false,
};
const shFrag = /* glsl */`
  uniform vec3 uTint; uniform float uAlpha;
  void main() { gl_FragColor = vec4(uTint * uAlpha, uAlpha); }`;
const shVert = /* glsl */`
  void main() { gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;
const shOff = new THREE.Vector2(-SUN.x / SUN.y, -SUN.z / SUN.y);
const shVerts = [];
const pushQuad = (a, b, c, d) => { shVerts.push(a, b, c, a, c, d); };
// тени реек: две непрерывные полосы на каждую сторону (связывают зубцы в гребёнку)
for (const [t0, t1] of [[0.02, 0.42], [0.50, 0.80]]) {
  for (const sz of [FZ, -FZ]) {
    pushQuad([-FX + shOff.x * t0, sz + shOff.y * t0], [FX + shOff.x * t0, sz + shOff.y * t0],
             [FX + shOff.x * t1, sz + shOff.y * t1], [-FX + shOff.x * t1, sz + shOff.y * t1]);
  }
  for (const sx of [FX, -FX]) {
    pushQuad([sx + shOff.x * t0, -FZ + shOff.y * t0], [sx + shOff.x * t0, FZ + shOff.y * t0],
             [sx + shOff.x * t1, FZ + shOff.y * t1], [sx + shOff.x * t1, -FZ + shOff.y * t1]);
  }
}
for (const [px, pz, ry] of picketPos) {
  const ux = Math.cos(ry), uz = -Math.sin(ry); // направление ширины штакетины в мире
  const prof = [[-0.07, 0], [0.07, 0], [0.07, 0.72], [0, 0.86], [-0.07, 0.72]];
  const pts = prof.map(([u, y]) => [px + ux * u + shOff.x * y, pz + uz * u + shOff.y * y]);
  for (let i = 1; i < 4; i++) shVerts.push(pts[0], pts[i], pts[i + 1]);
}
const fenceShadowGeo = new THREE.BufferGeometry();
fenceShadowGeo.setAttribute('position',
  new THREE.Float32BufferAttribute(shVerts.flatMap(([x, z]) => [x, 0.05, z]), 3));
const fenceShadow = new THREE.Mesh(fenceShadowGeo, new THREE.ShaderMaterial({
  uniforms: { uTint: { value: SH_TINT }, uAlpha: { value: SH_ALPHA } },
  vertexShader: shVert,
  fragmentShader: shFrag,
  side: THREE.DoubleSide, // полосы реек и зубцы имеют разный winding — не отсекать обратные грани
  ...shBlend,
  // Рейки забора (opaque, ro=0, пишут глубину) частично закрывают свои же полосы —
  // физически верно; связные тёмные раны в промежутках остаются ≥6 px.
  // Трафарет: гребёнка помечает свои сэмплы (ref=1) и рисует только где ref ≠ 1 —
  // её собственные зубцы ПЕРЕКРЫВАЮТ полосы реек, без трафарета overlap дал бы
  // двойное затемнение. Тень фигуры (ref=1, NotEqual) затемняет сэмпл ровно один
  // раз: в перекрытии цвет = цвет гребёнки == цвет тени фигуры (тот же tint/alpha).
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.KeepStencilOp,
  stencilZFail: THREE.KeepStencilOp,
  stencilZPass: THREE.ReplaceStencilOp,
}));
// после всех opaque-мешей (земля/тротуар/забор/косилка/фигура — renderOrder 0):
// буфер глубины уже содержит их силуэты, тень не перекрывает ни один из них
fenceShadow.renderOrder = 5;
fenceShadow.frustumCulled = false;
scene.add(fenceShadow);

// ---------- тень фигуры: projected-silhouette меш вместо карты теней ----------
// Раньше манекен+косилка рендерились в ортографическую shadowRT (Nearest, 1024²
// на 18×14 м) — край выходил грубой лесенкой, а силуэт читался как мазок+петля.
// Теперь силуэт строится каждый кадр из позы: каждая часть (голова/торс/ноги/
// дека/рукоятка) проецируется вдоль SUN на землю, выпуклая оболочка проекции
// даёт гладкий контур (MSAA рендерера сглаживает край), всё сливается в один
// merged-меш = 1 draw call. Фигура больше не кастер в shadowRT (нет двойной тени).
const FS_Y = 0.06;                       // высота плоскости тени над землёй (выше гребёнки 0.05)
const FS_MAX = 16384;                    // запас вершин (неиндексированные треугольники + декали)
const fsPos = new Float32Array(FS_MAX * 3);
const figureShadowGeo = new THREE.BufferGeometry();
figureShadowGeo.setAttribute('position', new THREE.BufferAttribute(fsPos, 3));
figureShadowGeo.setDrawRange(0, 0);
const figureShadow = new THREE.Mesh(figureShadowGeo, new THREE.ShaderMaterial({
  uniforms: { uTint: { value: SH_TINT }, uAlpha: { value: SH_ALPHA } },
  vertexShader: shVert,
  fragmentShader: shFrag,
  side: THREE.DoubleSide,
  ...shBlend,
  // Трафарет: рисуем только где ref ≠ 1 и сами ставим ref=1 на пройденных
  // сэмплах. Эффект: (a) пиксели гребёнки (ref=1) НЕ умножаются повторно —
  // цвет перекрытия == цвет тени фигуры на чистом газоне (тот же tint/alpha);
  // (b) перекрывающиеся оболочки частей фигуры тоже затемняют сэмпл один раз.
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.KeepStencilOp,
  stencilZFail: THREE.KeepStencilOp,
  stencilZPass: THREE.ReplaceStencilOp,
}));
// ro=6 > гребёнки ro=5: фигура рисуется после неё; y=0.06 выше гребёнки (0.05),
// depthWrite:false у обеих — coplanar-боя нет, перекрытие разруливает трафарет
figureShadow.renderOrder = 6;
figureShadow.frustumCulled = false;
scene.add(figureShadow);

// базис плоскости, перпендикулярной SUN: терминатор сферы/капсулы лежит в ней
const _fsU = new THREE.Vector3().crossVectors(SUN, new THREE.Vector3(0, 1, 0)).normalize();
const _fsV = new THREE.Vector3().crossVectors(SUN, _fsU).normalize();
const _fsP = new THREE.Vector3(), _fsW = new THREE.Vector3();
let fsCount = 0;                          // счётчик вершин текущего кадра

// выпуклая оболочка 2D-точек (Andrew monotone chain), возвращает массив [x,z]
function fsHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
// веерная триангуляция оболочки в общий буфер; map(q) → мировые [x,y,z]
function fsEmit(hull, map) {
  if (hull.length < 3) return;
  for (let i = 1; i < hull.length - 1; i++) {
    if (fsCount + 3 > FS_MAX) return;
    for (const q of [hull[0], hull[i], hull[i + 1]]) {
      const v = map(q);
      fsPos[fsCount * 3] = v[0]; fsPos[fsCount * 3 + 1] = v[1]; fsPos[fsCount * 3 + 2] = v[2];
      fsCount++;
    }
  }
}
const fsGroundMap = q => [q[0], FS_Y, q[1]];
// вертикальные декали: внутренние грани правого забора (x=FX−0.0225, нормаль −X)
// и дальнего (z=−FZ+0.0225, нормаль +Z). ε перед гранью — декаль не тонет в
// штакетине/рейке; depthTest:true — фигура/косилка между камерой и гранью
// корректно перекрывают декаль. Всё в том же merged-буфере = 1 draw call.
const FS_EPS = 0.01;
const FS_RX = FX - 0.0225 - FS_EPS;      // плоскость правого забора
const FS_FZ = -FZ + 0.0225 + FS_EPS;     // плоскость дальнего забора
const fsRightMap = q => [FS_RX, q[1], q[0]];   // q = [z, y] грани
const fsFarMap = q => [q[0], q[1], FS_FZ];     // q = [x, y] грани
// горизонтальная декаль на крышке деки косилки (deckTop: локальный y=0.285,
// 0.44×0.56): тень фигуры/двигателя/рукоятки падает НА косилку, а не исчезает
// под ней. q = [lx, lz] в координатах косилки; ε над крышкой — без z-fight.
const FS_DY = 0.285;
const fsDeckMap = q => {
  const c = Math.cos(state.heading), s = Math.sin(state.heading);
  return [state.x + q[0] * c + q[1] * s, FS_DY + 0.006, state.z - q[0] * s + q[1] * c];
};
function fsInDeck(lx, lz) {
  const ax = Math.abs(lx) - (0.22 - 0.05), az = Math.abs(lz) - (0.28 - 0.05);
  if (Math.abs(lx) > 0.22 || Math.abs(lz) > 0.28) return false;
  return !(ax > 0 && az > 0 && ax * ax + az * az > 0.05 * 0.05);
}
// одна часть фигуры: оболочка проекции на землю + декали на гранях забора.
// Проекция вдоль −SUN: Q = P − s·SUN, s>0 только со стороны газона.
// KEEP: высота в пределах штакетины (мир y ∈ [−0.03, 0.83] = локальные 0…0.86)
// и координата вдоль грани в пределах пролёта забора.
function fsPart(pts) {
  const g = [], pr = [], pf = [], pd = [];
  const c = Math.cos(state.heading), s = Math.sin(state.heading);
  for (const p of pts) {
    g.push([p[0] + shOff.x * p[1], p[2] + shOff.y * p[1]]);
    const sr = (p[0] - FS_RX) / SUN.x;   // правый забор: t=(P.x−plane)/SUN.x
    if (sr > 0) {
      const y = p[1] - sr * SUN.y, z = p[2] - sr * SUN.z;
      if (y >= -0.03 && y <= 0.83 && Math.abs(z) <= FZ) pr.push([z, y]);
    }
    const sf = (p[2] - FS_FZ) / SUN.z;   // дальний забор: t=(P.z−plane)/SUN.z
    if (sf > 0) {
      const y = p[1] - sf * SUN.y, x = p[0] - sf * SUN.x;
      if (y >= -0.03 && y <= 0.83 && Math.abs(x) <= FX) pf.push([x, y]);
    }
    const sd = (p[1] - FS_DY) / SUN.y;   // крышка деки: t=(P.y−plane)/SUN.y
    if (sd > 0) {
      const dx = p[0] - sd * SUN.x - state.x, dz = p[2] - sd * SUN.z - state.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (fsInDeck(lx, lz)) pd.push([lx, lz]);
    }
  }
  fsEmit(fsHull(g), fsGroundMap);
  if (pr.length >= 3) fsEmit(fsHull(pr), fsRightMap);
  if (pf.length >= 3) fsEmit(fsHull(pf), fsFarMap);
  if (pd.length >= 3) fsEmit(fsHull(pd), fsDeckMap);
}
// тень сферы: терминатор (окружность ⊥ SUN) проецируется в эллипс
function fsSphere(center, r, n = 18) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    _fsP.copy(center).addScaledVector(_fsU, Math.cos(a) * r).addScaledVector(_fsV, Math.sin(a) * r);
    pts.push([_fsP.x, _fsP.y, _fsP.z]);
  }
  fsPart(pts);
}
// тень капсулы A→B: оболочка проекций терминаторов на обоих концах
function fsCapsule(a, b, r, n = 14) {
  const pts = [];
  for (const c of [a, b]) {
    for (let i = 0; i < n; i++) {
      const ang = i / n * Math.PI * 2;
      _fsP.copy(c).addScaledVector(_fsU, Math.cos(ang) * r).addScaledVector(_fsV, Math.sin(ang) * r);
      pts.push([_fsP.x, _fsP.y, _fsP.z]);
    }
  }
  fsPart(pts);
}
// тень скруглённого бокса: контуры верхней и нижней граней, спроецированные вместе
function fsRoundedBox(cx, cy, cz, w, h, d, r, yaw) {
  const pts = [];
  const hx = w / 2 - r, hz = d / 2 - r;
  const corners = [[hx, hz, 0], [-hx, hz, Math.PI / 2], [-hx, -hz, Math.PI], [hx, -hz, Math.PI * 1.5]];
  const cy0 = cy - h / 2, cy1 = cy + h / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const yy of [cy0, cy1]) {
    for (const [ox, oz, a0] of corners) {
      for (let i = 0; i <= 4; i++) {
        const a = a0 + i / 4 * Math.PI / 2;
        const lx = ox + Math.cos(a) * r, lz = oz + Math.sin(a) * r;
        _fsP.set(cx + lx * c + lz * s, yy, cz - lx * s + lz * c);
        pts.push([_fsP.x, _fsP.y, _fsP.z]);
      }
    }
  }
  fsPart(pts);
}
const _fsA = new THREE.Vector3(), _fsB = new THREE.Vector3(), _fsC = new THREE.Vector3();
const _fsAnk = [new THREE.Vector3(), new THREE.Vector3()];
function charToWorld(v, out) { return out.copy(v).applyMatrix4(charGroup.matrixWorld); }
function mowerToWorld(x, y, z, out) { return out.set(x, y, z).applyMatrix4(mowerRoot.matrixWorld); }

function updateFigureShadow() {
  mowerRoot.updateMatrixWorld(true);
  fsCount = 0;
  // --- человек: голова/торс/таз/плечи/руки/ноги/стопы ---
  fsSphere(charToWorld(head.position, _fsA), 0.125);                 // голова+шапка
  charToWorld(pelvis.position, _fsA); charToWorld(neck.position, _fsB);
  fsCapsule(_fsA, _fsB, 0.16);                                       // торс
  fsSphere(charToWorld(pelvis.position, _fsA), 0.16);                // таз
  fsSphere(charToWorld(shoulderL.position, _fsA), 0.08);
  fsSphere(charToWorld(shoulderR.position, _fsA), 0.08);
  for (const side of [-1, 1]) {
    const sh = side < 0 ? shoulderL : shoulderR;
    const el = side < 0 ? elbowL : elbowR, ha = side < 0 ? handL : handR;
    charToWorld(sh.position, _fsA); charToWorld(el.position, _fsB); charToWorld(ha.position, _fsC);
    fsCapsule(_fsA, _fsB, 0.055);                                    // плечо
    fsCapsule(_fsB, _fsC, 0.05);                                     // предплечье
    fsSphere(_fsC, 0.065);                                           // кисть
    const leg = side < 0 ? legL : legR;
    const f = gait.feet[side < 0 ? 0 : 1];
    leg.hip.getWorldPosition(_fsA); leg.knee.getWorldPosition(_fsB);
    _fsAnk[side < 0 ? 0 : 1].set(f.sole.x, f.sole.y + ANKLE_H, f.sole.z);
    fsCapsule(_fsA, _fsB, 0.07);                                     // бедро
    fsCapsule(_fsB, _fsAnk[side < 0 ? 0 : 1], 0.06);                 // голень
    fsSphere(_fsB, 0.07);                                            // колено
    _fsA.set(f.sole.x, f.sole.y + 0.03, f.sole.z);
    fsSphere(_fsA, 0.09);                                            // стопа
  }
  // --- косилка: дека/двигатель/рукоятка ---
  fsRoundedBox(state.x, 0.16, state.z, 0.56, 0.17, 0.74, 0.06, state.heading); // дека
  mowerToWorld(0, 0.255, -0.10, _fsA); mowerToWorld(0, 0.405, -0.10, _fsB);
  fsCapsule(_fsA, _fsB, 0.12);                                       // двигатель
  mowerToWorld(-0.20, 0.26, -0.30, _fsA); mowerToWorld(-0.20, 0.95, -0.68, _fsB);
  fsCapsule(_fsA, _fsB, 0.024);                                      // левая стойка рукоятки
  mowerToWorld(0.20, 0.26, -0.30, _fsA); mowerToWorld(0.20, 0.95, -0.68, _fsB);
  fsCapsule(_fsA, _fsB, 0.024);                                      // правая стойка
  mowerToWorld(-0.24, 0.95, -0.68, _fsA); mowerToWorld(0.24, 0.95, -0.68, _fsB);
  fsCapsule(_fsA, _fsB, 0.024);                                      // перекладина грипа
  // колёса не добавляем: они под декой, а их выступы дают острые углы на контуре
  figureShadowGeo.attributes.position.needsUpdate = true;
  figureShadowGeo.setDrawRange(0, fsCount);
}

function renderShadowPass() {
  shadowCam.position.set(state.x, 0, state.z).addScaledVector(SUN, 45);
  shadowCam.lookAt(state.x, 0, state.z);
  shadowCam.updateMatrixWorld();
  shadowMat4.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  const bg = scene.background;
  scene.background = null;
  renderer.setRenderTarget(shadowRT);
  renderer.setClearColor(0xffffff, 1);
  scene.overrideMaterial = shOverride;
  renderer.render(scene, shadowCam);
  scene.overrideMaterial = null;
  renderer.setRenderTarget(null);
  scene.background = bg;
}

// ---------- отладочная проекция: корпус / нож / отпечаток в маске ----------
let debugOn = false;
const dbgGroup = new THREE.Group();
dbgGroup.visible = false;
scene.add(dbgGroup);
const deckPts = [];
{
  const w = 0.56 / 2, d = 0.74 / 2, r = 0.06;
  const corners = [[w - r, d - r, 0], [-w + r, d - r, Math.PI / 2],
                   [-w + r, -d + r, Math.PI], [w - r, -d + r, Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = i / 8 * Math.PI / 2;
      deckPts.push(new THREE.Vector3(cx + Math.cos(a0 + a) * r, 0.31, cz + Math.sin(a0 + a) * r));
    }
  }
}
const deckLine = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(deckPts),
  new THREE.LineBasicMaterial({ color: 0xff8800, transparent: true }));
deckLine.renderOrder = 2;
deckLine.visible = false;
mowerRoot.add(deckLine);
const bladeGeo = new THREE.BufferGeometry();
bladeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(66 * 3), 3));
const bladeLine = new THREE.Line(bladeGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true }));
bladeLine.renderOrder = 2;
dbgGroup.add(bladeLine);
const dbgCanvas = document.createElement('canvas');
dbgCanvas.width = dbgCanvas.height = 128;
const dctx = dbgCanvas.getContext('2d');
const dbgTex = new THREE.CanvasTexture(dbgCanvas);
dbgTex.minFilter = dbgTex.magFilter = THREE.LinearFilter;
dbgTex.generateMipmaps = false;
const dbgPlane = new THREE.Mesh(new THREE.PlaneGeometry(6, 6),
  new THREE.MeshBasicMaterial({ map: dbgTex, transparent: true, opacity: 0.5, color: 0xff5544, depthWrite: false }));
dbgPlane.rotation.x = -Math.PI / 2;
dbgGroup.add(dbgPlane);
function updateDebug() {
  const s = lastStamp || { x0: state.x, z0: state.z, x1: state.x, z1: state.z };
  const th = Math.atan2(s.z1 - s.z0, s.x1 - s.x0);
  const R = BLADE_W / 2;
  const P = bladeGeo.attributes.position.array;
  let k = 0;
  for (let i = 0; i <= 32; i++) {
    const a = th - Math.PI / 2 + (i / 32) * Math.PI;
    P[k++] = s.x1 + Math.cos(a) * R; P[k++] = 0.33; P[k++] = s.z1 + Math.sin(a) * R;
  }
  for (let i = 0; i <= 32; i++) {
    const a = th + Math.PI / 2 + (i / 32) * Math.PI;
    P[k++] = s.x0 + Math.cos(a) * R; P[k++] = 0.33; P[k++] = s.z0 + Math.sin(a) * R;
  }
  bladeGeo.attributes.position.needsUpdate = true;
  bladeGeo.computeBoundingSphere();
  dctx.clearRect(0, 0, 128, 128);
  dctx.drawImage(maskCanvas, (state.x - 3 + LAWN_W / 2) * PPM, (state.z - 3 + LAWN_D / 2) * PPM,
    6 * PPM, 6 * PPM, 0, 0, 128, 128);
  dbgTex.needsUpdate = true;
  dbgPlane.position.set(state.x, 0.045, state.z); // выше высокой травы, иначе проекция скрыта
}

let shadowEnabled = true; // для замера стоимости прохода тени
let shWhiteTex = null;    // белая заглушка: честный baseline «без тени»
function renderFrame() {
  fenceShadow.visible = shadowEnabled;
  figureShadow.visible = shadowEnabled;
  if (shadowEnabled) renderShadowPass();
  if (debugOn) updateDebug();
  renderer.render(scene, camera);
}

// ---------- прогресс ----------
// знаменатель — косимая площадь: весь газон (BORDER = 0, нож достаёт до кромки),
// углы скруглены вылетом ножа (туда нож дотягивается при развороте)
const PROG_W = 208, PROG_H = 144;
const progCanvas = document.createElement('canvas');
progCanvas.width = PROG_W; progCanvas.height = PROG_H;
const pctx = progCanvas.getContext('2d', { willReadFrequently: true });
const mowRegion = new Uint8Array(PROG_W * PROG_H);
let MOW_PIXELS = 0;
for (let py = 0; py < PROG_H; py++) {
  for (let px = 0; px < PROG_W; px++) {
    const x = (px + 0.5) / PROG_W * LAWN_W - LAWN_W / 2;
    const z = (py + 0.5) / PROG_H * LAWN_D - LAWN_D / 2;
    const ax = Math.abs(x), az = Math.abs(z);
    let inside = ax <= MOW_HX && az <= MOW_HZ;
    if (inside && ax > CTR_HX && az > CTR_HZ) {
      const dx = ax - CTR_HX, dz = az - CTR_HZ;
      inside = dx * dx + dz * dz <= BLADE_REACH * BLADE_REACH;
    }
    if (inside) { mowRegion[py * PROG_W + px] = 1; MOW_PIXELS++; }
  }
}
const progressEl = document.getElementById('progress');
let lastProgress = '';
function mowedFraction() {
  pctx.clearRect(0, 0, PROG_W, PROG_H);
  pctx.drawImage(maskCanvas, 0, 0, PROG_W, PROG_H);
  const d = pctx.getImageData(0, 0, PROG_W, PROG_H).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    // перекрытие проходов считается один раз: пиксель либо тронут ножом, либо нет
    if (d[i] > 0 && mowRegion[i >> 2]) n++;
  }
  return n / MOW_PIXELS;
}
function updateProgress(force) {
  const f = mowedFraction();
  const n = Math.round(f * MOW_PIXELS);
  let label;
  if (n === 0) label = '0';
  else if (n >= MOW_PIXELS) label = '100';
  else if (f * 100 < 1) label = '<1';
  else label = String(Math.floor(f * 100));
  const txt = `Скошено ${label}%`;
  if (force || txt !== lastProgress) {
    progressEl.textContent = txt;
    lastProgress = txt;
  }
}

// ---------- ввод ----------
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
addEventListener('keydown', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
});
addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = false; e.preventDefault(); }
});
for (const [id, k] of [['t-up', 'up'], ['t-down', 'down'], ['t-left', 'left'], ['t-right', 'right']]) {
  const el = document.getElementById(id);
  const on = e => { e.preventDefault(); keys[k] = true; };
  const off = e => { e.preventDefault(); keys[k] = false; };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}
document.getElementById('reset').addEventListener('click', () => reset());
// потеря фокуса / скрытие вкладки: сбрасываем удержания, иначе пропущенный keyup
// оставил бы косилку продолжать движение
function clearKeys() { keys.up = keys.down = keys.left = keys.right = false; }
addEventListener('blur', clearKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  layoutCamera();
});

// ---------- главный цикл ----------
let last = performance.now(), acc = 0, frame = 0;
const FIXED = 1 / 60;
function tick(now) {
  requestAnimationFrame(tick);
  let dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  acc += dt;
  while (acc >= FIXED) { physicsStep(FIXED); acc -= FIXED; }
  syncVisuals(dt);
  renderFrame();
  if (++frame % 20 === 0) updateProgress(false);
  if (!window.__READY) window.__READY = true;
}

reset();
requestAnimationFrame(tick);

// ---------- хуки для приёмки ----------
window.__MOW = {
  get state() { return { ...state }; },
  keys,
  renderer,
  scene,
  camera,
  screenToWorld(px, py) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2((px - r.left) / r.width * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    const t = -rc.ray.origin.y / rc.ray.direction.y;
    const p = rc.ray.origin.clone().addScaledVector(rc.ray.direction, t);
    return [p.x, p.z];
  },
  shadows() { return { mode: 'shadow-map', res: SHADOW_RES,
    sun: SUN.toArray().map(n => +n.toFixed(3)),
    casters: 1 /* fence */ + 1 /* mowerRoot со всей позой манекена */,
    debug: debugOn }; },
  debug(on) {
    debugOn = !!on;
    dbgGroup.visible = debugOn;
    deckLine.visible = debugOn;
    if (debugOn) { updateDebug(); renderFrame(); }
    return debugOn;
  },
  setKeys(partial) { Object.assign(keys, partial); },
  simulate(seconds, keysOverride) {
    const saved = { ...keys };
    if (keysOverride) Object.assign(keys, keysOverride);
    const steps = Math.round(seconds / FIXED);
    for (let i = 0; i < steps; i++) physicsStep(FIXED);
    if (keysOverride) Object.assign(keys, saved);
    syncVisuals(0.016);
    renderFrame();
    updateProgress(true);
    return { ...state };
  },
  teleport(x, z, heading) {
    state.x = x; state.z = z; state.heading = heading; state.speed = 0;
    mowGuide = null; guidePause = 0;
    stampHere();
    syncVisuals(0.016);
    renderFrame();
  },
  sampleMask(x, z) {
    const [px, py] = worldToMask(x, z);
    const d = mctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
    return d[0] / 255;
  },
  mowedFraction,
  reset,
  probePixel(x, z) {
    renderFrame(); // без preserveDrawingBuffer буфер живёт только внутри задачи
    const v = new THREE.Vector3(x, TALL_H * 0.5, z).project(camera);
    const c = renderer.domElement;
    const gl = renderer.getContext();
    const buf = new Uint8Array(4);
    gl.readPixels(Math.round((v.x * 0.5 + 0.5) * c.width), Math.round((v.y * 0.5 + 0.5) * c.height),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2]];
  },
  probeBlock(x, z, px) {
    renderFrame();
    const v = new THREE.Vector3(x, 0, z).project(camera);
    const c = renderer.domElement;
    const gl = renderer.getContext();
    const cx = Math.round((v.x * 0.5 + 0.5) * c.width);
    const cy = Math.round((v.y * 0.5 + 0.5) * c.height);
    const buf = new Uint8Array(px * px * 4);
    gl.readPixels(cx - (px >> 1), cy - (px >> 1), px, px, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const g = [];
    for (let i = 1; i < buf.length; i += 4) g.push(buf[i]);
    g.sort((a, b) => a - b);
    const med = g[g.length >> 1];
    let dark = 0, light = 0;
    for (const q of g) { if (q < med - 25) dark++; if (q > med + 25) light++; }
    return { med, dark, light, total: g.length };
  },
  pump(now) { tick(now ?? performance.now()); },
  setShadow(on) {
    shadowEnabled = !!on;
    if (!shWhiteTex) {
      shWhiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      shWhiteTex.needsUpdate = true;
    }
    groundUniforms.uShadow.value = on ? shadowRT.texture : shWhiteTex;
    return shadowEnabled;
  },
  // временный просмотр содержимого карты теней на отладочной плоскости
  shadowView(on) {
    debugOn = !!on; dbgGroup.visible = !!on;
    deckLine.visible = false; bladeLine.visible = false;
    dbgPlane.material.map = on ? shadowRT.texture : dbgTex;
    dbgPlane.material.color.set(on ? 0xffffff : 0xff5544);
    dbgPlane.material.opacity = on ? 1.0 : 0.5;
    dbgPlane.scale.set(on ? 3 : 1, on ? 7 / 3 : 1, 1);
    dbgPlane.material.needsUpdate = true;
  },
  setView(x, z, halfH) {
    camOverride = (x === null) ? null : { x, z };
    if (halfH) { viewHalfH = halfH; layoutCamera(); }
    if (camOverride) { camTarget.set(x, 0, z); syncVisuals(0.016); renderFrame(); }
  },
  // --- хуки походки и разворота (приёмка задач A/B) ---
  footWorld(side) {
    const f = gait.feet[side === 'left' ? 0 : 1];
    return { x: f.sole.x, y: f.sole.y, z: f.sole.z, yaw: f.yaw, mode: f.mode };
  },
  get gait() {
    return { phase: gait.phase, steps: gait.steps, stepLen: gait.L,
      stance: gait.steps % 2 === 0 ? 'left' : 'right',
      charSpeed: gait.charSpeed, yawRate: gait.yawRate, settle: gait.settle,
      poseMode: pose.mode, beta: pose.beta, twist: gait.twist,
      relaxing: gait.relaxing, settled: gait.settled,
      clipOn: !!CLIP.data, clipName: CLIP.gen && CLIP.gen.name,
      clipBlend: +CLIP.blend.toFixed(2), clipBob: +CLIP.bob.toFixed(3),
      clipRate: CLIP.gen && +CLIP.gen.rate.toFixed(2), clipKL: CLIP.gen && +CLIP.gen.kL.toFixed(2) };
  },
  charWorld() {
    const [x, z] = charWorldXZ();
    return { x, z, angle: pose.angle, radius: Math.hypot(pose.localX, pose.localZ),
      dx: x - state.x, dz: z - state.z };
  },
  // диагностика IK: мировые позиции бедра/колена/лодыжки (проверка сгиба вперёд)
  legDebug(side) {
    const leg = side === 'left' ? legL : legR;
    mowerRoot.updateMatrixWorld(true);
    const w = o => { const v = new THREE.Vector3(); o.getWorldPosition(v); return { x: v.x, y: v.y, z: v.z }; };
    const hip = w(leg.hip), knee = w(leg.knee), foot = w(leg.foot);
    const f = gait.feet[side === 'left' ? 0 : 1];
    // колено должно быть выше лодыжки и ниже бедра, и смещено вперёд по курсу фигуры
    const fwd = { x: Math.sin(pose.angle), z: Math.cos(pose.angle) };
    const chord = { x: f.sole.x - hip.x, z: f.sole.z - hip.z };
    const kneeOff = { x: knee.x - hip.x, z: knee.z - hip.z };
    const forwardDot = kneeOff.x * fwd.x + kneeOff.z * fwd.z;
    // сгиб вперёд относительно хорды бедро→лодыжка (анterior, не вывернуто назад):
    // в сагиттальной плоскости (z вперёд, y вверх) передняя нормаль хорды = (-Cy, Cz)
    const Cy = f.sole.y - hip.y, Cz = chord.x * fwd.x + chord.z * fwd.z;
    const Kz = forwardDot, Ky = knee.y - hip.y;
    const anteriorDot = -Kz * Cy + Ky * Cz;
    // строгая проверка в локальной системе фигуры (полюс IK = +z, h>=0):
    const hl = charGroup.worldToLocal(new THREE.Vector3(hip.x, hip.y, hip.z));
    const kl = charGroup.worldToLocal(new THREE.Vector3(knee.x, knee.y, knee.z));
    const al = charGroup.worldToLocal(new THREE.Vector3(
      f.sole.x - Math.sin(f.yaw) * ANKLE_OFF, f.sole.y + ANKLE_H,
      f.sole.z - Math.cos(f.yaw) * ANKLE_OFF));
    const lCy = al.y - hl.y, lCz = al.z - hl.z;
    const lKz = kl.z - hl.z, lKy = kl.y - hl.y;
    const anteriorLocal = -lKz * lCy + lKy * lCz;
    const sl = charGroup.worldToLocal(new THREE.Vector3(f.sole.x, f.sole.y, f.sole.z));
    return { hip, knee, foot, soleY: f.sole.y, mode: f.mode, yaw: f.yaw,
      soleLocalX: sl.x, soleLocalZ: sl.z,
      kneeAboveAnkle: knee.y > f.sole.y, kneeBelowHip: knee.y < hip.y,
      kneeForwardDot: forwardDot, anteriorDot, anteriorLocal };
  },
  // simulate с покадровым логом стоп/фазы для числовых ассертов
  gaitRun(seconds, keysOverride, every = 2) {
    const saved = { ...keys };
    if (keysOverride) Object.assign(keys, keysOverride);
    const n = Math.round(seconds / FIXED), log = [];
    for (let i = 0; i < n; i++) {
      physicsStep(FIXED);
      if (i % every === 0) {
        const [cx, cz] = charWorldXZ();
        const L = gait.feet[0], R = gait.feet[1];
        log.push({ t: +((i + 1) * FIXED).toFixed(4), ph: gait.phase, st: gait.steps,
          sl: gait.L, cs: gait.charSpeed,
          lx: L.sole.x, ly: L.sole.y, lz: L.sole.z, lm: L.mode,
          rx: R.sole.x, ry: R.sole.y, rz: R.sole.z, rm: R.mode,
          cx, cz, h: state.heading, mx: state.x, mz: state.z });
      }
    }
    if (keysOverride) Object.assign(keys, saved);
    syncVisuals(0.016); renderFrame(); updateProgress(true);
    return log;
  },
};
