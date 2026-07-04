(function () {
  "use strict";

  var canvas = document.getElementById("shader-canvas");
  if (!canvas) return;

  var gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance"
  });

  if (!gl) {
    document.body.classList.add("no-webgl");
    return;
  }

  var vertexSource = [
    "attribute vec2 aPosition;",
    "varying vec2 vUv;",
    "void main() {",
    "  vUv = aPosition * 0.5 + 0.5;",
    "  gl_Position = vec4(aPosition, 0.0, 1.0);",
    "}"
  ].join("\n");

  var fragmentSource = [
    "precision mediump float;",
    "varying vec2 vUv;",
    "uniform vec2 uResolution;",
    "uniform float uTime;",
    "uniform vec2 uPointer;",
    "uniform vec3 uAccentA;",
    "uniform vec3 uAccentB;",
    "uniform vec3 uAccentC;",
    "uniform float uScene;",
    "",
    "mat2 rot(float a) {",
    "  float s = sin(a);",
    "  float c = cos(a);",
    "  return mat2(c, -s, s, c);",
    "}",
    "",
    "float hash(vec2 p) {",
    "  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);",
    "}",
    "",
    "float noise(vec2 p) {",
    "  vec2 i = floor(p);",
    "  vec2 f = fract(p);",
    "  vec2 u = f * f * (3.0 - 2.0 * f);",
    "  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),",
    "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);",
    "}",
    "",
    "float fbm(vec2 p) {",
    "  float value = 0.0;",
    "  float amplitude = 0.55;",
    "  for (int i = 0; i < 5; i++) {",
    "    value += amplitude * noise(p);",
    "    p = rot(0.55) * p * 2.02 + vec2(4.2, 1.3);",
    "    amplitude *= 0.52;",
    "  }",
    "  return value;",
    "}",
    "",
    "void main() {",
    "  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / min(uResolution.x, uResolution.y);",
    "  vec2 pointer = (uPointer * 2.0 - 1.0) * vec2(1.0, -1.0);",
    "  float time = uTime * 0.13;",
    "  vec2 flow = rot(uScene * 0.17 + 0.15) * uv;",
    "  float field = fbm(flow * 1.25 + vec2(time, -time * 0.55));",
    "  float fieldB = fbm(flow * 2.0 - vec2(time * 0.42, time * 0.18) + field);",
    "  float fieldC = fbm(flow * 3.1 + vec2(-time * 0.28, time * 0.88) + fieldB);",
    "  float band = sin((uv.x + fieldB * 0.42 + uScene * 0.2) * 6.6 - time * 4.2) * 0.5 + 0.5;",
    "  float pulse = sin(time * 2.4 + uScene) * 0.5 + 0.5;",
    "  float pointerGlow = exp(-4.2 * length(uv - pointer * 0.3)) * (0.85 + band * 0.45);",
    "  float rim = smoothstep(1.32, 0.18, length(uv * vec2(0.9, 1.1)));",
    "  vec3 color = mix(vec3(0.02, 0.03, 0.07), uAccentA, smoothstep(0.16, 0.94, field));",
    "  color = mix(color, uAccentB, smoothstep(0.26, 0.98, fieldB + band * 0.18));",
    "  color += uAccentC * smoothstep(0.34, 1.0, fieldC + pointerGlow * 0.45) * 0.78;",
    "  color += mix(uAccentB, uAccentC, pulse) * pointerGlow * 0.92;",
    "  color += uAccentA * pow(max(0.0, 1.0 - length(uv + vec2(0.36, -0.24))), 2.6) * 0.22;",
    "  color *= 0.55 + rim * 0.75;",
    "  color = pow(color, vec3(0.92));",
    "  gl_FragColor = vec4(color, 0.96);",
    "}"
  ].join("\n");

  function compileShader(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(error || "Shader compile failed");
    }
    return shader;
  }

  function createProgram() {
    var program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
    }
    return program;
  }

  var program;
  try {
    program = createProgram();
  } catch (e) {
    console.error("[shader] init:", e.message);
    document.body.classList.add("no-webgl");
    return;
  }

  var positionLocation = gl.getAttribLocation(program, "aPosition");
  var resolutionLocation = gl.getUniformLocation(program, "uResolution");
  var timeLocation = gl.getUniformLocation(program, "uTime");
  var pointerLocation = gl.getUniformLocation(program, "uPointer");
  var accentALocation = gl.getUniformLocation(program, "uAccentA");
  var accentBLocation = gl.getUniformLocation(program, "uAccentB");
  var accentCLocation = gl.getUniformLocation(program, "uAccentC");
  var sceneLocation = gl.getUniformLocation(program, "uScene");

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]), gl.STATIC_DRAW);

  var paletteMap = {
    "screen-deals": {
      scene: 0,
      a: [0.14, 0.30, 0.88],
      b: [0.18, 0.83, 0.95],
      c: [0.61, 0.38, 0.98]
    },
    "screen-create": {
      scene: 1,
      a: [0.08, 0.40, 0.95],
      b: [0.20, 0.90, 0.72],
      c: [0.56, 0.39, 0.99]
    },
    "screen-deal": {
      scene: 2,
      a: [0.19, 0.33, 0.92],
      b: [0.97, 0.54, 0.34],
      c: [0.82, 0.29, 0.60]
    },
    "screen-profile": {
      scene: 3,
      a: [0.26, 0.33, 0.96],
      b: [0.29, 0.94, 0.82],
      c: [0.78, 0.41, 0.98]
    },
    "default": {
      scene: 0,
      a: [0.14, 0.30, 0.88],
      b: [0.18, 0.83, 0.95],
      c: [0.61, 0.38, 0.98]
    }
  };

  var current = {
    pointerX: 0.76,
    pointerY: 0.22,
    targetPointerX: 0.76,
    targetPointerY: 0.22,
    scene: 0,
    sceneTarget: 0,
    a: paletteMap["default"].a.slice(),
    b: paletteMap["default"].b.slice(),
    c: paletteMap["default"].c.slice(),
    targetA: paletteMap["default"].a.slice(),
    targetB: paletteMap["default"].b.slice(),
    targetC: paletteMap["default"].c.slice()
  };

  function setScene(screenId) {
    var palette = paletteMap[screenId] || paletteMap["default"];
    current.sceneTarget = palette.scene;
    current.targetA = palette.a.slice();
    current.targetB = palette.b.slice();
    current.targetC = palette.c.slice();
  }

  function syncSceneFromDom() {
    setScene(document.body.getAttribute("data-screen") || "screen-deals");
  }

  function resize() {
    var ratio = Math.min(window.devicePixelRatio || 1, 1.6);
    var width = Math.max(1, Math.round(window.innerWidth * ratio));
    var height = Math.max(1, Math.round(window.innerHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updatePointer(clientX, clientY) {
    current.targetPointerX = Math.min(Math.max(clientX / window.innerWidth, 0), 1);
    current.targetPointerY = Math.min(Math.max(clientY / window.innerHeight, 0), 1);
  }

  window.addEventListener("pointermove", function (event) {
    updatePointer(event.clientX, event.clientY);
  }, { passive: true });

  window.addEventListener("touchmove", function (event) {
    if (!event.touches || !event.touches[0]) return;
    updatePointer(event.touches[0].clientX, event.touches[0].clientY);
  }, { passive: true });

  window.addEventListener("northcat:screenchange", function (event) {
    var screenId = event && event.detail && event.detail.screen;
    setScene(screenId || "screen-deals");
  });

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) resize();
  });

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  resize();
  syncSceneFromDom();

  function render(now) {
    resize();

    current.pointerX = lerp(current.pointerX, current.targetPointerX, 0.035);
    current.pointerY = lerp(current.pointerY, current.targetPointerY, 0.035);
    current.scene = lerp(current.scene, current.sceneTarget, 0.04);

    for (var i = 0; i < 3; i++) {
      current.a[i] = lerp(current.a[i], current.targetA[i], 0.04);
      current.b[i] = lerp(current.b[i], current.targetB[i], 0.04);
      current.c[i] = lerp(current.c[i], current.targetC[i], 0.04);
    }

    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(timeLocation, now * 0.001);
    gl.uniform2f(pointerLocation, current.pointerX, current.pointerY);
    gl.uniform3fv(accentALocation, new Float32Array(current.a));
    gl.uniform3fv(accentBLocation, new Float32Array(current.b));
    gl.uniform3fv(accentCLocation, new Float32Array(current.c));
    gl.uniform1f(sceneLocation, current.scene);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    window.requestAnimationFrame(render);
  }

  window.requestAnimationFrame(render);
}());
