(function () {
  "use strict";

  const fs = require("fs");

  const registered = [];
  function track(item) {
    registered.push(item);
    return item;
  }

  const LOCKED_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1", "WAIST", "ROOT"]);

  // When false the bone guards are fully disabled, letting the user freely move
  // pivots and reparent bones. Toggled via the "Lock Root Bones" action.
  let boneLockEnabled = true;

  // Set to true during PSM import so the finished_edit guard doesn't roll back
  // the pivot changes that the import deliberately applies.
  let suppressBoneGuard = false;

  // cubeName    = display name shown in outliner
  // animFlag    = ANIM bit (mask) that hides/shows this cube when toggled
  //               (undefined = always visible, can never be hidden via ANIM)
  // ANIM masks:
  //   HEAD_DISABLED            = 0x400   (bit 10)
  //   LEFT_ARM_DISABLED        = 0x1000  (bit 12)
  //   RIGHT_ARM_DISABLED       = 0x800   (bit 11)
  //   BODY_DISABLED            = 0x2000  (bit 13)
  //   LEFT_LEG_DISABLED        = 0x8000  (bit 15)
  //   RIGHT_LEG_DISABLED       = 0x4000  (bit 14)
  //   HEAD_OVERLAY_DISABLED    = 0x10000 (bit 16)
  //   LEFT_ARM_OVERLAY_DISABLED  = 0x100000 (bit 20)
  //   RIGHT_ARM_OVERLAY_DISABLED = 0x200000 (bit 21)
  //   LEFT_LEG_OVERLAY_DISABLED  = 0x400000 (bit 22)
  //   RIGHT_LEG_OVERLAY_DISABLED = 0x800000 (bit 23)
  //   BODY_OVERLAY_DISABLED    = 0x1000000 (bit 24)
  const TEMPLATE_BONES = [
    {
      name: "HEAD",
      pivot: [0, 24, 0],
      cubes: [
        { cubeName: "HEAD", origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0, animFlag: 0x400 },
        {
          cubeName: "HEADWEAR",
          origin: [-4.5, 23.5, -4.5],
          size: [8, 8, 8],
          uv: [32, 0],
          inflate: 0.5,
          animFlag: 0x10000,
        },
      ],
    },
    {
      name: "BODY",
      pivot: [0, 24, 0],
      cubes: [
        { cubeName: "BODY", origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0, animFlag: 0x2000 },
        {
          cubeName: "JACKET",
          origin: [-4.25, 11.75, -2.25],
          size: [8, 12, 4],
          uv: [16, 32],
          inflate: 0.25,
          animFlag: 0x1000000,
        },
      ],
    },
    {
      name: "ARM0",
      pivot: [6, 22, 0],
      cubes: [
        { cubeName: "ARM0", origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0, animFlag: 0x800 },
        {
          cubeName: "SLEEVE0",
          origin: [3.7, 11.75, -2.25],
          size: [4, 12, 4],
          uv: [40, 32],
          inflate: 0.25,
          animFlag: 0x200000,
        },
      ],
    },
    {
      name: "ARM1",
      pivot: [-6, 22, 0],
      cubes: [
        { cubeName: "ARM1", origin: [-8, 12, -2], size: [4, 12, 4], uv: [32, 48], inflate: 0, animFlag: 0x1000 },
        {
          cubeName: "SLEEVE1",
          origin: [-8.28, 11.75, -2.25],
          size: [4, 12, 4],
          uv: [48, 48],
          inflate: 0.25,
          animFlag: 0x100000,
        },
      ],
    },
    {
      name: "LEG0",
      pivot: [2, 12, 0],
      cubes: [
        { cubeName: "LEG0", origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, animFlag: 0x4000 },
        {
          cubeName: "PANT0",
          origin: [-0.25, -0.3, -2.25],
          size: [4, 12, 4],
          uv: [0, 32],
          inflate: 0.25,
          animFlag: 0x800000,
        },
      ],
    },
    {
      name: "LEG1",
      pivot: [-2, 12, 0],
      cubes: [
        { cubeName: "LEG1", origin: [-4, 0, -2], size: [4, 12, 4], uv: [16, 48], inflate: 0, animFlag: 0x8000 },
        {
          cubeName: "PANT1",
          origin: [-4.25, -0.3, -2.25],
          size: [4, 12, 4],
          uv: [0, 48],
          inflate: 0.25,
          animFlag: 0x400000,
        },
      ],
    },
  ];

  // Map from template cube name -> ANIM flag mask that controls visibility.
  const TEMPLATE_CUBE_FLAG = {};
  TEMPLATE_BONES.forEach((boneDef) => {
    boneDef.cubes.forEach((c) => {
      if (c.animFlag !== undefined) TEMPLATE_CUBE_FLAG[c.cubeName] = c.animFlag;
    });
  });

  // Flat set of all template cube names (for guard checks).
  const TEMPLATE_CUBE_NAMES = new Set(Object.keys(TEMPLATE_CUBE_FLAG));

  // ── Template Ghost Meshes ────────────────────────────────────────────────
  // Instead of real Cube objects (which appear in the outliner), we inject
  // pure Three.js meshes directly into the scene.  They are completely
  // invisible to the outliner and cannot be selected, moved, or deleted.

  // Container added once to the scene; all ghost meshes live here.
  // Rotated 180° around Y so that +Z faces the viewer (matching Blockbench's
  // convention where the model front faces -Z in world space).
  const _templateGhostRoot = new THREE.Object3D();
  _templateGhostRoot.name = "pck_template_ghosts";
  _templateGhostRoot.rotation.y = Math.PI;
  scene.add(_templateGhostRoot);
  track({
    remove() {
      scene.remove(_templateGhostRoot);
    },
  });

  // Default fallback skin texture — loaded once from the plugin's own base64.
  // Used when the project has no texture yet (or the texture map isn't ready).
  let _fallbackSkinMap = null;
  function _getFallbackSkinMap(defaultSkinB64) {
    if (_fallbackSkinMap) return _fallbackSkinMap;
    const img = new Image();
    img.src = defaultSkinB64;
    const map = new THREE.Texture(img);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    img.onload = () => {
      map.needsUpdate = true;
    };
    _fallbackSkinMap = map;
    return map;
  }

  // Build UV attribute for a THREE.BoxGeometry matching Minecraft box-UV layout.
  //
  // Minecraft box-UV pixel regions (W=sizeX, H=sizeY, D=sizeZ, u/v = uv_offset):
  //   right  (+X): [u,         v+D] .. [u+D,         v+D+H]
  //   left   (-X): [u+D+W,     v+D] .. [u+D+W+D,     v+D+H]
  //   top    (+Y): [u+D,       v  ] .. [u+D+W,        v+D  ]
  //   bottom (-Y): [u+D+W,     v  ] .. [u+D+W+W,      v+D  ]
  //   front  (+Z): [u+D,       v+D] .. [u+D+W,        v+D+H]
  //   back   (-Z): [u+D+W+D,   v+D] .. [u+D+W+D+W,   v+D+H]
  //
  // THREE.BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
  // Each face has 4 vertices written as: tl, bl, tr, br
  // (top-left, bottom-left, top-right, bottom-right of the face as seen from outside)
  //
  // Mirror analysis (derived from BoxGeometry buildPlane udir/vdir):
  //   +X right:  Three.js uv.x=0 -> +Z front, Minecraft left col = back  -> mirrorU=YES
  //   -X left:   Three.js uv.x=0 -> -Z back,  Minecraft left col = front -> mirrorU=YES
  //   +Y top:    no mirror needed
  //   -Y bottom: no mirror needed
  //   +Z front:  no mirror needed
  //   -Z back:   no mirror needed
  // mirrorX: when true, mirrors the entire box horizontally (left/right faces swap,
  // all U coordinates flipped). Used for the 64x32 classic layout where ARM1/LEG1
  // share the same UV strip as ARM0/LEG0 but are rendered on the opposite side.
  function _buildBoxUVs(W, H, D, uvOffset, uvW, uvH, mirrorX, mirrorBottom) {
    const u = uvOffset[0];
    const v = uvOffset[1];

    // pixel (px,py) -> normalised UV. Three.js V=0 is bottom so we flip V.
    function n(px, py) {
      return [px / uvW, 1.0 - py / uvH];
    }

    // Build 8 UV values for one face in BoxGeometry vertex order: tl, tr, bl, br.
    // mirrorU swaps left/right so the texture strip reads in the correct direction.
    // When mirrorX is active the effective mirror is inverted for every face.
    function face(fu, fv, fw, fh, mirrorU, mirrorV) {
      const m = mirrorX ? !mirrorU : mirrorU;
      const l = m ? fu + fw : fu;
      const r = m ? fu : fu + fw;
      const t = mirrorV ? fv + fh : fv;
      const b = mirrorV ? fv : fv + fh;
      return [...n(l, t), ...n(r, t), ...n(l, b), ...n(r, b)];
    }

    // Face order: +X, -X, +Y, -Y, +Z, -Z
    // When mirrorX is set the +X and -X slots are swapped so the side panels
    // sample the correct (now-mirrored) region of the UV strip.
    const faceRight = face(u + D + W, v + D, D, H, false); // +X side
    const faceLeft = face(u, v + D, D, H, false); // -X side
    const faces = [
      mirrorX ? faceLeft : faceRight, // +X slot
      mirrorX ? faceRight : faceLeft, // -X slot
      face(u + D, v, W, D, false), // +Y top
      face(u + D + W, v, W, D, false, !!mirrorBottom), // -Y bottom
      face(u + D, v + D, W, H, false), // +Z front
      face(u + D + W + D, v + D, W, H, false), // -Z back
    ];

    const arr = new Float32Array(24 * 2);
    faces.forEach((f, fi) => {
      for (let i = 0; i < 8; i++) arr[fi * 8 + i] = f[i];
    });
    return arr;
  }

  function _getSkinMap() {
    const tex = Texture.all[0];
    if (!tex) return null;
    const mat = tex.getMaterial && tex.getMaterial();
    if (!mat) return null;
    return mat.map || (mat.uniforms && mat.uniforms.map && mat.uniforms.map.value) || null;
  }

  const GHOST_VERT = [
    "varying vec2 vUv;",
    "varying float light;",
    "uniform bool SHADE;",
    "void main() {",
    "  if (SHADE) {",
    "    vec3 N = vec3(modelMatrix * vec4(normal, 0.0));",
    "    float yLight = (1.0 - N.z) * 0.5;",
    "    light = yLight * 0.4 + N.x*N.x * 0.075 + N.y*N.y * 0.175 + 0.6;",
    "  } else { light = 1.0; }",
    "  vUv = uv;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    "}",
  ].join("\n");

  const GHOST_FRAG = [
    "#ifdef GL_ES",
    "precision highp float;",
    "#endif",
    "uniform sampler2D t0;",
    "varying vec2 vUv;",
    "varying float light;",
    "void main(void) {",
    "  vec4 tx = texture2D(t0, vUv);",
    "  gl_FragColor = vec4(tx.rgb * light, tx.a);",
    "  if (gl_FragColor.a < 0.05) discard;",
    "}",
  ].join("\n");

  function _buildGhostMaterial(map) {
    return new THREE.ShaderMaterial({
      uniforms: {
        t0: { value: map },
        SHADE: { value: settings.shading.value },
      },
      vertexShader: GHOST_VERT,
      fragmentShader: GHOST_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
    });
  }

  // Slim-arm overrides applied when the SLIM_MODEL ANIM flag (0x80000) is set.
  // These replace the standard 4-wide arm/sleeve cubes with the 3-wide Alex variants.
  // Both arms are shifted 1 unit towards the body (ARM0 origin.x +1, ARM1 origin.x +1).
  const SLIM_ARM_OVERRIDES = {
    ARM0: { origin: [4, 12, -2], size: [3, 12, 4], uv: [40, 16] },
    SLEEVE0: { origin: [3.75, 11.75, -2.25], size: [3, 12, 4], uv: [40, 32] },
    ARM1: { origin: [-7, 12, -2], size: [3, 12, 4], uv: [32, 48] },
    SLEEVE1: { origin: [-7.25, 11.75, -2.25], size: [3, 12, 4], uv: [48, 48] },
  };

  // Classic 64×32 layout overrides applied when neither SLIM_MODEL (0x80000)
  // nor RESOLUTION_64x64 (0x40000) is set.
  //
  // The 64×32 texture has no second-layer rows (V ≥ 32), so:
  //   • All overlay cubes (HEADWEAR, JACKET, SLEEVE0/1, PANT0/1) are hidden.
  //   • ARM1 / LEG1 mirror their counterpart's UV instead of using the
  //     64×64-only bottom-half UV coordinates.
  //   • The UV normaliser uses height=32 so V coords map correctly.
  const CLASSIC_32_OVERLAY_CUBES = new Set(["JACKET", "SLEEVE0", "SLEEVE1", "PANT0", "PANT1"]);
  const CLASSIC_32_UV_OVERRIDES = {
    ARM1: { uv: [40, 16], mirrorX: true }, // same UV strip as ARM0, mirrored horizontally
    LEG1: { uv: [0, 16], mirrorX: true }, // same UV strip as LEG0, mirrored horizontally
  };

  // Rebuild all ghost meshes. Called after skeleton is built and on texture/flag change.
  //
  // Each ghost mesh is parented directly to the corresponding real Blockbench bone's
  // THREE.js mesh (group.mesh), so the animator drives the ghosts automatically —
  // rotations, translations and the full bone hierarchy all apply for free.
  //
  // Ghost cube positions are expressed in bone-local space:
  //   local = cube_world_center - bone_pivot
  //
  // The _templateGhostRoot container is kept only as a scene-level owner for cleanup;
  // actual ghost meshes live under their bone's group.mesh, not under this root.
  function rebuildTemplateGhosts() {
    // Clear old ghosts — remove from wherever they were parented
    const oldGhosts = [];
    _templateGhostRoot.traverse((obj) => {
      if (obj !== _templateGhostRoot) oldGhosts.push(obj);
    });
    oldGhosts.forEach((obj) => obj.parent && obj.parent.remove(obj));
    // Also sweep any ghosts that may have been parented directly to bone meshes
    Group.all.forEach((group) => {
      if (!group.mesh) return;
      const toRemove = group.mesh.children.filter((c) => c.name && c.name.startsWith("pck_ghost_"));
      toRemove.forEach((c) => group.mesh.remove(c));
    });

    if (!Format || Format.id !== "pck_skin") return;
    if (!Project) return;

    const skinMap = _getSkinMap() || _getFallbackSkinMap(_DEFAULT_SKIN_B64);
    const texH = (Texture.all[0] && Texture.all[0].height) || 64;
    const flags = Project.psm_anim_flags || 0;
    const isSlim = (flags & 0x80000) !== 0;
    const is64x64 = (flags & 0x40000) !== 0;
    // Classic 64×32 mode: neither Slim nor 64×64 is checked
    const isClassic32 = !isSlim && !is64x64;

    TEMPLATE_BONES.forEach((boneDef) => {
      // Find the live Blockbench Group for this bone
      const boneGroup = Group.all.find((g) => g.name === boneDef.name);
      // group.mesh is the Three.js Object3D the animator drives.
      // Fall back to _templateGhostRoot if the bone isn't ready yet (shouldn't happen
      // after Canvas.updateAll(), but be safe).
      const boneTarget = boneGroup && boneGroup.mesh ? boneGroup.mesh : _templateGhostRoot;
      const pivot = boneDef.pivot; // [px, py, pz] in Blockbench world space

      boneDef.cubes.forEach((cubeDef) => {
        // Respect ANIM flags — skip ghost when the flag bit is set
        if (cubeDef.animFlag !== undefined && (flags & cubeDef.animFlag) !== 0) return;

        // Classic 64×32: hide all second-layer (overlay) cubes
        if (isClassic32 && CLASSIC_32_OVERLAY_CUBES.has(cubeDef.cubeName)) return;

        // Determine geometry/UV source in priority order:
        //   1. Slim overrides (3-wide arms)       — when SLIM_MODEL is set
        //   2. Classic 32 UV overrides (mirrored) — when neither flag is set
        //   3. Default TEMPLATE_BONES values       — when RESOLUTION_64x64 is set
        const slimOverride = isSlim ? SLIM_ARM_OVERRIDES[cubeDef.cubeName] : null;
        const classic32Override = isClassic32 ? CLASSIC_32_UV_OVERRIDES[cubeDef.cubeName] : null;

        const origin = slimOverride ? slimOverride.origin : cubeDef.origin;
        const size = slimOverride ? slimOverride.size : cubeDef.size;
        const uv = slimOverride ? slimOverride.uv : classic32Override ? classic32Override.uv : cubeDef.uv;
        const mirrorX = slimOverride ? !!slimOverride.mirrorX : classic32Override ? !!classic32Override.mirrorX : false;

        // Classic 64×32 textures are 32px tall; use that as the UV normaliser height
        const uvTexH = isClassic32 ? 32 : texH;

        const [ox, oy, oz] = origin;
        const [sw, sh, sd] = size;
        const inf = cubeDef.inflate || 0;

        // The head cubes' bottom face needs V-flipping due to Three.js winding
        const mirrorBottom = cubeDef.cubeName === "HEAD" || cubeDef.cubeName === "HEADWEAR";

        const geom = new THREE.BoxGeometry(sw + inf * 2, sh + inf * 2, sd + inf * 2);
        const uvs = _buildBoxUVs(sw, sh, sd, uv, 64, uvTexH, mirrorX, mirrorBottom);
        geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

        const mat = _buildGhostMaterial(skinMap);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = "pck_ghost_" + cubeDef.cubeName;

        // Cube world-space centre
        const cx = ox + (sw + inf * 2) / 2;
        const cy = oy + (sh + inf * 2) / 2;
        const cz = oz + (sd + inf * 2) / 2;

        if (boneTarget === _templateGhostRoot) {
          // Fallback path: _templateGhostRoot is rotated 180° around Y, so negate X and Z
          mesh.position.set(-cx, cy, -cz);
        } else {
          // Bone-local space: offset from the bone pivot.
          mesh.position.set(cx - pivot[0], cy - pivot[1], cz - pivot[2]);
          // Rotate 180° on Y so the UV faces align correctly with Blockbench's
          // bone scene graph orientation (bone meshes are already Y-rotated 180°).
          mesh.rotation.y = Math.PI;
        }

        boneTarget.add(mesh);
      });
    });
  }
  function buildTemplateSkeleton() {
    // ROOT is the top-level container — locked, not exported, pivot at origin.
    const rootGroup = new Group({ name: "ROOT", origin: [0, 0, 0] }).init();
    rootGroup.export = false;

    // WAIST is the upper-body container — locked, not exported, pivot at Y=12 by default.
    const WAIST_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1"]);
    const LEG_BONES = new Set(["LEG0", "LEG1"]);
    const waistGroup = new Group({ name: "WAIST", origin: [0, 12, 0] }).addTo(rootGroup).init();
    waistGroup.export = false;

    TEMPLATE_BONES.forEach((boneDef) => {
      let parent;
      if (WAIST_BONES.has(boneDef.name)) parent = waistGroup;
      else if (LEG_BONES.has(boneDef.name)) parent = rootGroup;
      const group = new Group({ name: boneDef.name, origin: boneDef.pivot });
      if (parent) group.addTo(parent);
      group.init();
    });

    // Place armor locators now that all bones exist.
    buildArmorLocators();

    // Ghost meshes are built once the skeleton Groups have their .mesh assigned,
    // which happens after Canvas.updateAll() in the caller.
    requestAnimationFrame(() => rebuildTemplateGhosts());
  }

  function onNameChanged({ object, new_name, old_name }) {
    if (Format.id !== "pck_skin") return;
    if (!boneLockEnabled) return;
    if (!(object instanceof Group)) return;
    if (!LOCKED_BONES.has(old_name)) return;

    object.name = old_name;
    Blockbench.showQuickMessage(`"${old_name}" is a locked bone — it cannot be renamed.`, 2200);
    Canvas.updateAll();
  }

  // ── Draw Mode ──────────────────────────────────────────────────────────────
  // Draw Mode places real Cube objects matching every template bone cube so the
  // user can paint directly on them. The cubes are locked, not exported, and
  // protected against being moved, reparented, rotated or deleted.
  // They are removed automatically when Draw Mode is toggled off.

  let drawModeEnabled = false;

  // UUID prefix that tags every draw-mode cube so they are identifiable across
  // all guards without needing a separate Set.
  const DRAW_MODE_UUID_PREFIX = "dddddddd";

  function isDrawModeCube(cube) {
    return cube && typeof cube.uuid === "string" && cube.uuid.startsWith(DRAW_MODE_UUID_PREFIX);
  }

  function drawModeUuid() {
    return DRAW_MODE_UUID_PREFIX + guid().substr(8);
  }

  function clearDrawModeCubes() {
    // Collect first so we don't mutate Cube.all while iterating.
    const toRemove = Cube.all.filter(isDrawModeCube);
    toRemove.forEach((c) => c.remove());
    Canvas.updateAll();
  }

  // Correct world-space cube definitions for Draw Mode, one set per UV layout.
  // These are independent of TEMPLATE_BONES (which uses a different coordinate
  // convention tuned for the Three.js ghost meshes).
  const DRAWMODE_BONES_64 = [
    {
      name: "HEAD",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0 },
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5 },
      ],
    },
    {
      name: "BODY",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0 },
        { origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 32], inflate: 0.25 },
      ],
    },
    {
      name: "ARM0",
      pivot: [6, 22, 0],
      cubes: [
        { origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0 },
        { origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 32], inflate: 0.25 },
      ],
    },
    {
      name: "ARM1",
      pivot: [-6, 22, 0],
      cubes: [
        { origin: [-8, 12, -2], size: [4, 12, 4], uv: [32, 48], inflate: 0 },
        { origin: [-8, 12, -2], size: [4, 12, 4], uv: [48, 48], inflate: 0.25 },
      ],
    },
    {
      name: "LEG0",
      pivot: [2, 12, 0],
      cubes: [
        { origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0 },
        { origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 32], inflate: 0.25 },
      ],
    },
    {
      name: "LEG1",
      pivot: [-2, 12, 0],
      cubes: [
        { origin: [-4, 0, -2], size: [4, 12, 4], uv: [16, 48], inflate: 0 },
        { origin: [-4, 0, -2], size: [4, 12, 4], uv: [0, 48], inflate: 0.25 },
      ],
    },
  ];

  const DRAWMODE_BONES_SLIM = [
    {
      name: "HEAD",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0 },
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5 },
      ],
    },
    {
      name: "BODY",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0 },
        { origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 32], inflate: 0.25 },
      ],
    },
    {
      name: "ARM0",
      pivot: [-6, 22, 0],
      cubes: [
        { origin: [-7, 12, -2], size: [3, 12, 4], uv: [32, 48], inflate: 0 },
        { origin: [-7, 12, -2], size: [3, 12, 4], uv: [48, 48], inflate: 0.25 },
      ],
    },
    {
      name: "ARM1",
      pivot: [6, 22, 0],
      cubes: [
        { origin: [4, 12, -2], size: [3, 12, 4], uv: [40, 16], inflate: 0 },
        { origin: [4, 12, -2], size: [3, 12, 4], uv: [40, 32], inflate: 0.25 },
      ],
    },
    {
      name: "LEG0",
      pivot: [-2, 12, 0],
      cubes: [
        { origin: [-4, 0, -2], size: [4, 12, 4], uv: [16, 48], inflate: 0 },
        { origin: [-4, 0, -2], size: [4, 12, 4], uv: [0, 48], inflate: 0.25 },
      ],
    },
    {
      name: "LEG1",
      pivot: [2, 12, 0],
      cubes: [
        { origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0 },
        { origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 32], inflate: 0.25 },
      ],
    },
  ];

  const DRAWMODE_BONES_32 = [
    {
      name: "HEAD",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0 },
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5 },
      ],
    },
    {
      name: "BODY",
      pivot: [0, 24, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0 }],
    },
    {
      name: "ARM0",
      pivot: [-6, 22, 0],
      cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0, mirror_uv: true }],
    },
    {
      name: "ARM1",
      pivot: [6, 22, 0],
      cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0 }],
    },
    {
      name: "LEG0",
      pivot: [-2, 12, 0],
      cubes: [{ origin: [-4, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, mirror_uv: true }],
    },
    {
      name: "LEG1",
      pivot: [2, 12, 0],
      cubes: [{ origin: [0, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0 }],
    },
  ];

  function placeDrawModeCubes() {
    const flags = Project.psm_anim_flags || 0;
    const isSlim = (flags & 0x80000) !== 0;
    const is64x64 = (flags & 0x40000) !== 0;
    const isClassic32 = !isSlim && !is64x64;

    const boneDefs = isSlim ? DRAWMODE_BONES_SLIM : isClassic32 ? DRAWMODE_BONES_32 : DRAWMODE_BONES_64;

    boneDefs.forEach((boneDef) => {
      const boneGroup = Group.all.find((g) => g.name === boneDef.name);
      if (!boneGroup) return;

      boneDef.cubes.forEach((cubeDef) => {
        const [ox, oy, oz] = cubeDef.origin;
        const [sw, sh, sd] = cubeDef.size;
        const inf = cubeDef.inflate || 0;

        new Cube(
          {
            name: boneDef.name,
            from: [ox - inf, oy - inf, oz - inf],
            to: [ox + sw + inf, oy + sh + inf, oz + sd + inf],
            uv_offset: [cubeDef.uv[0], cubeDef.uv[1]],
            mirror_uv: !!cubeDef.mirror_uv,
            box_uv: true,
            export: false,
            locked: false,
          },
          drawModeUuid(),
        )
          .addTo(boneGroup)
          .init();
      });
    });

    Canvas.updateAll();
  }

  // All ghost-visibility flags that Drawable Ghost sets when it turns on, so the
  // Three.js ghost is fully hidden while real drawable cubes are in the viewport.
  // Covers every Disabled + OverlayOff bit.
  const DRAWABLE_GHOST_HIDE_MASK =
    0x400 | // HEAD_DISABLED
    0x800 | // RIGHT_ARM_DISABLED
    0x1000 | // LEFT_ARM_DISABLED
    0x2000 | // BODY_DISABLED
    0x4000 | // RIGHT_LEG_DISABLED
    0x8000 | // LEFT_LEG_DISABLED
    0x10000 | // HEAD_OVERLAY_DISABLED
    0x100000 | // LEFT_ARM_OVERLAY_DISABLED
    0x200000 | // RIGHT_ARM_OVERLAY_DISABLED
    0x400000 | // LEFT_LEG_OVERLAY_DISABLED
    0x800000 | // RIGHT_LEG_OVERLAY_DISABLED
    0x1000000; // BODY_OVERLAY_DISABLED

  // Flags that were already set before Drawable Ghost turned on — we must not
  // clear those when turning it off again.
  let _drawModePreExistingFlags = 0;

  function setDrawMode(enabled) {
    drawModeEnabled = enabled;
    const action = BarItems["pck_toggle_draw_mode"];
    if (drawModeEnabled) {
      // Remember which hide-flags were already active so we only restore the
      // ones we newly set (don't clear flags the user had set themselves).
      _drawModePreExistingFlags = (Project.psm_anim_flags || 0) & DRAWABLE_GHOST_HIDE_MASK;

      // Force all ghost-part flags on so the Three.js ghost fully disappears.
      Project.psm_anim_flags = (Project.psm_anim_flags || 0) | DRAWABLE_GHOST_HIDE_MASK;
      syncAnimPanel();
      syncTemplateCubeVisibility();

      placeDrawModeCubes();
      if (action) {
        action.name = "Toggle Drawable Ghost";
        action.icon = "brush";
      }
      Blockbench.showQuickMessage("Drawable Ghost ON — template cubes placed. Press again to remove them.", 2500);
    } else {
      // Restore: clear only the flags we added (leave user-set ones intact).
      const flagsToRemove = DRAWABLE_GHOST_HIDE_MASK & ~_drawModePreExistingFlags;
      Project.psm_anim_flags = (Project.psm_anim_flags || 0) & ~flagsToRemove;
      syncAnimPanel();
      syncTemplateCubeVisibility();

      clearDrawModeCubes();
      if (action) {
        action.name = "Toggle Drawable Ghost";
        action.icon = "edit_off";
      }
      Blockbench.showQuickMessage("Drawable Ghost OFF — template cubes removed.", 2000);
    }
  }

  // Push the current psm_anim_flags value into the ANIM panel Vue component.
  function syncAnimPanel() {
    const animPanel = Interface.Panels.pck_anim;
    if (animPanel && animPanel.inside_vue) {
      animPanel.inside_vue.anim_flags = Project.psm_anim_flags || 0;
    }
  }

  function onFinishedEdit() {
    if (Format.id !== "pck_skin") return;
    if (!boneLockEnabled || suppressBoneGuard) return;

    const last = Undo.history[Undo.history.length - 1];
    if (!last || !last.before || !last.before.groups) return;

    const beforeGroups = last.before.groups;
    let violated = false;
    let pivotChanged = false;

    Group.all.forEach((group) => {
      if (!LOCKED_BONES.has(group.name)) return;
      const snapshot = beforeGroups[group.uuid];
      if (!snapshot) return;

      const parentBefore = snapshot.parent || "";
      const parentNow = group.parent instanceof Group ? group.parent.uuid : "";
      if (parentBefore !== parentNow) violated = true;

      if (
        snapshot.origin &&
        (snapshot.origin[0] !== group.origin[0] ||
          snapshot.origin[1] !== group.origin[1] ||
          snapshot.origin[2] !== group.origin[2])
      ) {
        pivotChanged = true;
      }
    });

    // Check for any newly-applied rotations on groups or cubes.
    // PSM does not support rotations — roll back if any appear.
    const isRotated = (r) => r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0);
    const ROTATION_EXEMPT = new Set(["cape", "elytraRight", "elytraLeft"]);

    const beforeElements = (last.before && last.before.elements) || {};

    let rotationViolated = false;

    Group.all.forEach((group) => {
      if (isRotated(group.rotation)) rotationViolated = true;
    });

    if (!rotationViolated) {
      Cube.all.forEach((cube) => {
        if (ROTATION_EXEMPT.has(cube.name)) return;
        if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) return;
        if (cube.uuid.startsWith(DRAW_MODE_UUID_PREFIX)) return; // draw-mode cubes may not rotate (locked)
        if (isRotated(cube.rotation)) rotationViolated = true;
      });
    }

    if (rotationViolated) {
      Undo.loadSave(last.before, last.post);
      Undo.history.pop();
      Undo.index = Undo.history.length;
      Blockbench.showQuickMessage("Rotations are not supported in PSM — the rotation has been reverted.", 2500);
      return;
    }

    if (violated) {
      Undo.loadSave(last.before, last.post);
      Undo.history.pop();
      Undo.index = Undo.history.length;
      Blockbench.showQuickMessage("Locked bones cannot be moved or reparented — only their pivots may change.", 2500);
      return;
    }

    if (pivotChanged) {
      rebuildTemplateGhosts();
      if (Modes.animate) rebuildArmorCubes();
    }

    // Zero out any rotations applied to armor locators — they are position-only.
    let locatorRotated = false;
    Locator.all.forEach((loc) => {
      if (!isArmorLocator(loc)) return;
      if (loc.rotation && (loc.rotation[0] !== 0 || loc.rotation[1] !== 0 || loc.rotation[2] !== 0)) {
        loc.rotation = [0, 0, 0];
        locatorRotated = true;
      }
    });
    if (locatorRotated) {
      Canvas.updateAll();
      Blockbench.showQuickMessage("Armor locators are position-only — rotation has been cleared.", 2200);
    }

    // Rebuild armor whenever an armor locator has been moved.
    const beforeLocators = (last.before && last.before.locators) || {};
    let locatorMoved = false;
    Locator.all.forEach((loc) => {
      if (!isArmorLocator(loc)) return;
      const snap = beforeLocators[loc.uuid];
      if (!snap) return;
      if (
        snap.position &&
        (snap.position[0] !== loc.position[0] ||
          snap.position[1] !== loc.position[1] ||
          snap.position[2] !== loc.position[2])
      ) {
        locatorMoved = true;
      }
    });
    if (locatorMoved && Modes.animate) {
      rebuildArmorCubes();
    }
  }

  function onCubeAdded({ object }) {
    if (Format.id !== "pck_skin") return;
    if (!object.box_uv) {
      object.box_uv = true;
    }
  }

  function onCloseProject() {
    clearArmorLocators();
    // Clear ghost meshes — they may be parented to bone meshes, not _templateGhostRoot
    const oldGhosts = [];
    _templateGhostRoot.traverse((obj) => {
      if (obj !== _templateGhostRoot) oldGhosts.push(obj);
    });
    oldGhosts.forEach((obj) => obj.parent && obj.parent.remove(obj));
    Group.all.forEach((group) => {
      if (!group.mesh) return;
      group.mesh.children.filter((c) => c.name && c.name.startsWith("pck_ghost_")).forEach((c) => group.mesh.remove(c));
    });
    // Reset lock state so each new project starts locked.
    if (!boneLockEnabled) {
      boneLockEnabled = true;
      const action = BarItems["pck_toggle_bone_lock"];
      if (action) {
        action.name = "Unlock Root Bones";
        action.icon = "lock_open";
      }
    }
    // Reset draw mode so the new project starts clean.
    if (drawModeEnabled) {
      // Restore any flags we had set before clearing state.
      if (Project.psm_anim_flags !== undefined) {
        const flagsToRemove = DRAWABLE_GHOST_HIDE_MASK & ~_drawModePreExistingFlags;
        Project.psm_anim_flags = (Project.psm_anim_flags || 0) & ~flagsToRemove;
      }
      drawModeEnabled = false;
      _drawModePreExistingFlags = 0;
      const action = BarItems["pck_toggle_draw_mode"];
      if (action) {
        action.name = "Toggle Drawable Ghost";
        action.icon = "edit_off";
      }
    }
  }

  Blockbench.on("change_element_name", onNameChanged);
  Blockbench.on("finished_edit", onFinishedEdit);
  Blockbench.on("add_cube", onCubeAdded);
  Blockbench.on("close_project", onCloseProject);

  track({
    delete() {
      Blockbench.removeListener("change_element_name", onNameChanged);
      Blockbench.removeListener("finished_edit", onFinishedEdit);
      Blockbench.removeListener("add_cube", onCubeAdded);
      Blockbench.removeListener("close_project", onCloseProject);
    },
  });

  const _origProjectParse = Codecs.project.parse;

  Codecs.project.parse = function (model, path) {
    if (model && model.meta) {
      if (model.meta.model_format === "pck_skin") {
      } else if (model.meta.model_format === "bedrock" && model.meta.box_uv === true) {
        model.meta.model_format = "pck_skin";
        if (!model.meta.format_version) {
          model.meta.format_version = "4.5";
        }
      }
    }

    return _origProjectParse.call(this, model, path);
  };

  track({
    delete() {
      Codecs.project.parse = _origProjectParse;
    },
  });

  function validateSkeleton() {
    const issues = [];

    const presentBoneNames = new Set(Group.all.map((g) => g.name));

    // Valid skeleton structure:
    //   Root level:    ROOT only
    //   Under ROOT:    WAIST, LEG0, LEG1
    //   Under WAIST:   HEAD, BODY, ARM0, ARM1
    //   Under bones:   cubes only, OR known offset folders
    //   Under folders: cubes only
    const VALID_UNDER_ROOT = new Set(["WAIST", "LEG0", "LEG1"]);
    const VALID_UNDER_WAIST = new Set(["HEAD", "BODY", "ARM0", "ARM1"]);
    const VALID_OFFSET_FOLDERS = new Set([
      "TOOL0",
      "TOOL1",
      "HELMET",
      "SHOULDER0",
      "SHOULDER1",
      "CHEST",
      "PANTS0",
      "PANTS1",
      "BOOT0",
      "BOOT1",
    ]);

    // All required bones must be present
    ["ROOT", "WAIST", "HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"].forEach((requiredName) => {
      if (!presentBoneNames.has(requiredName)) {
        issues.push({
          name: "Missing or renamed bone",
          description:
            `The required bone **"${requiredName}"** is missing. ` +
            `Required bones must keep their original names and cannot be deleted or replaced.`,
        });
      }
    });

    // Root level: only ROOT allowed
    Group.all.forEach((group) => {
      if (group.parent instanceof Group) return;
      if (group.name !== "ROOT") {
        issues.push({
          name: "Unexpected root bone",
          description:
            `Found **"${group.name}"** at the root level. ` +
            `Only **ROOT** may sit at the top level — all other bones must be nested inside it.`,
        });
      }
    });

    // Under ROOT: only WAIST, LEG0, LEG1 allowed
    Group.all
      .filter((g) => g.parent instanceof Group && g.parent.name === "ROOT")
      .forEach((group) => {
        if (!VALID_UNDER_ROOT.has(group.name)) {
          issues.push({
            name: "Unexpected bone inside ROOT",
            description:
              `Found **"${group.name}"** inside ROOT. ` + `Only WAIST, LEG0, and LEG1 may be direct children of ROOT.`,
          });
        }
      });

    // Under WAIST: only HEAD, BODY, ARM0, ARM1 allowed
    Group.all
      .filter((g) => g.parent instanceof Group && g.parent.name === "WAIST")
      .forEach((group) => {
        if (!VALID_UNDER_WAIST.has(group.name)) {
          issues.push({
            name: "Unexpected bone inside WAIST",
            description:
              `Found **"${group.name}"** inside WAIST. ` +
              `Only HEAD, BODY, ARM0, and ARM1 may be direct children of WAIST.`,
          });
        }
      });

    // Under the 6 main bones: only cubes OR known offset folders allowed
    Group.all.forEach((group) => {
      if (!(group.parent instanceof Group)) return;
      const parentName = group.parent.name;
      if (parentName === "ROOT" || parentName === "WAIST") return; // handled above
      if (VALID_OFFSET_FOLDERS.has(group.name)) return; // valid offset folder
      issues.push({
        name: "Invalid sub-folder",
        description:
          `Found a sub-folder named **"${group.name}"** inside **"${parentName}"**. ` +
          `Only cubes and recognised offset folders (HELMET, CHEST, SHOULDER0/1, BOOT0/1, etc.) are allowed inside bones.`,
      });
    });

    // Any PNG size is permitted — no texture-size validation needed.

    Group.all.forEach((group) => {
      if (group.parent instanceof Group) return;
      const r = group.rotation;
      if (r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) {
        issues.push({
          name: "Rotated root bone",
          description:
            `Root bone **"${group.name}"** has a rotation of [${r.map((v) => Math.round(v * 100) / 100).join(", ")}]. ` +
            `Root bones cannot be rotated — please reset its rotation to [0, 0, 0].`,
        });
      }
    });

    // Cubes must live inside one of the 6 main bones (HEAD/BODY/ARM0/ARM1/LEG0/LEG1)
    // or inside a valid offset folder that is itself inside one of those bones.
    // Cubes at scene root, or directly inside ROOT or WAIST, are invalid.
    const MAIN_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"]);
    Cube.all.forEach((cube) => {
      if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) return;
      if (cube.uuid.startsWith(DRAW_MODE_UUID_PREFIX)) return;
      if (Project.pck_armor_cubes && Project.pck_armor_cubes.includes(cube)) return;

      const parent = cube.parent;
      let isValidPlacement = false;

      if (parent instanceof Group) {
        if (MAIN_BONES.has(parent.name)) {
          // Direct child of a main bone — always valid
          isValidPlacement = true;
        } else if (VALID_OFFSET_FOLDERS.has(parent.name)) {
          // Inside an offset folder — valid only if that folder's own parent is a main bone
          const grandparent = parent.parent;
          if (grandparent instanceof Group && MAIN_BONES.has(grandparent.name)) {
            isValidPlacement = true;
          }
        }
      }

      if (!isValidPlacement) {
        const location = !(parent instanceof Group) ? "the scene root" : `**"${parent.name}"**`;
        issues.push({
          name: "Cube in invalid location",
          description:
            `Cube **"${cube.name}"** is placed inside ${location}. ` +
            `Cubes must be inside one of the main bones: HEAD, BODY, ARM0, ARM1, LEG0, or LEG1 ` +
            `(or inside a recognised offset folder nested under one of those bones). ` +
            `Cubes placed at scene root or inside ROOT/WAIST are not exported.`,
        });
      }
    });

    const ROTATION_IGNORED_NAMES = new Set(["cape", "elytraRight", "elytraLeft"]);
    Cube.all.forEach((cube) => {
      if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) return;
      if (cube.uuid.startsWith(DRAW_MODE_UUID_PREFIX)) return; // draw-mode template cubes — not exported
      if (Project.pck_armor_cubes && Project.pck_armor_cubes.includes(cube)) return;
      if (ROTATION_IGNORED_NAMES.has(cube.name)) return;
      const r = cube.rotation;
      if (r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) {
        const boneName = cube.parent instanceof Group ? cube.parent.name : "?";
        issues.push({
          name: "Rotated cube",
          description:
            `Cube **"${cube.name}"** inside bone **"${boneName}"** has a rotation of [${r.map((v) => Math.round(v * 100) / 100).join(", ")}]. ` +
            `Cubes cannot be rotated — please reset its rotation to [0, 0, 0].`,
        });
      }
    });

    if (issues.length === 0) return true;

    const form = {
      0: {
        type: "info",
        text: `Validation found ${issues.length} issue${issues.length > 1 ? "s" : ""}. Please fix ${issues.length > 1 ? "them" : "it"} before exporting:`,
      },
    };
    issues.forEach((issue, idx) => {
      form[idx + 1] = {
        type: "info",
        text: `**${issue.name}**: ${issue.description}`,
      };
    });

    new Dialog({
      id: "pck_skin_validation",
      title: "PCK Skin — Validation Failed",
      buttons: ["OK"],
      confirmIndex: 0,
      cancelIndex: 0,
      form,
    }).show();

    return false;
  }

  async function validateAndSaveSkinSheet() {
    if (!validateSkeleton()) return;

    if (!Texture.all.length) {
      Blockbench.showMessageBox({
        title: "No Textures",
        message: "Please add a skin texture before validating.",
        buttons: ["OK"],
      });
      return;
    }

    const skinName = (Project.name || "skin").replace(/\s+/g, "_");

    const skinSheetDataUrl = await (async () => {
      const offscreen = new Preview({ id: "pck_skin_offscreen", antialias: false, offscreen: true });

      const shadingWas = settings.shading.value;
      const brightnessWas = settings.brightness.value;
      settings.shading.value = false;
      settings.brightness.value = 50;
      Canvas.updateShading();
      const wasAnimate = !!Modes.animate;
      if (wasAnimate) Modes.options.edit.select();

      const capeTex = Texture.all[1] || null;
      const armorWas = Object.assign({}, armorPieces);
      let playingAnimWas = null;
      if (capeTex) {
        Modes.options.animate.select();
        if (typeof Timeline !== "undefined" && Timeline.playing) {
          playingAnimWas = Animation.selected || null;
          Timeline.pause();
        }
        Object.keys(armorPieces).forEach((k) => {
          armorPieces[k] = false;
        });
        armorPieces.cape = true;
        rebuildArmorCubes();
      }

      const canvas = document.createElement("canvas");
      canvas.width = 1760;
      canvas.height = 1600;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      const colDark = "#cacad4";
      const colMid = "#989ca5";

      ctx.fillStyle = "#282c34";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = "60px sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = colDark;
      ctx.fillText(`${skinName}  |  Legacy Skin`, 48, 112);

      const skinTex = Texture.all.find((t) => t.img && t.img.src && t !== Texture.all[1]);
      if (skinTex) {
        ctx.fillStyle = "#3e90ff";
        ctx.fillRect(43, 175, 522, 522);
        ctx.fillStyle = "#f4f3ff";
        ctx.fillRect(48, 180, 512, 512);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(skinTex.img, 0, 0, skinTex.width || 64, skinTex.height || 64, 48, 180, 512, 512);
        ctx.imageSmoothingEnabled = false;
        ctx.font = "36px sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = colMid;
        ctx.fillText(`Skin Texture (${skinTex.width || 64}×${skinTex.height || 64})`, 48, 180 + 512 + 46);
      }

      if (capeTex && capeTex.img && capeTex.img.src) {
        const swatchX = 48 + 512 + 24;
        const swatchW = 512;
        const swatchH = 256;
        ctx.fillStyle = "#3e90ff";
        ctx.fillRect(swatchX - 5, 175, swatchW + 10, swatchH + 10);
        ctx.fillStyle = "#f4f3ff";
        ctx.fillRect(swatchX, 180, swatchW, swatchH);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(capeTex.img, 0, 0, capeTex.width || 64, capeTex.height || 32, swatchX, 180, swatchW, swatchH);
        ctx.font = "36px sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = colMid;
        ctx.fillText(`Cape Texture (${capeTex.width || 64}×${capeTex.height || 32})`, swatchX, 180 + swatchH + 46);
      }

      const promises = [];

      function shot(dx, dy, w, h, anglePreset) {
        offscreen.loadAnglePreset(anglePreset);
        if (anglePreset.focal_length) offscreen.camPers.setFocalLength(anglePreset.focal_length);
        offscreen.resize(w, h);
        promises.push(
          new Promise((resolve) => {
            offscreen.screenshot({ crop: false }, (dataUrl) => {
              const img = new Image();
              img.onload = () => {
                ctx.drawImage(img, 0, 0, w, h, dx, dy, w, h);
                resolve();
              };
              img.src = dataUrl;
            });
          }),
        );
      }

      function label(text, x, y) {
        ctx.font = "36px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = colMid;
        ctx.fillText(text, x, y);
      }

      const W = 330,
        H = 720;

      // Temporarily hide draw-mode cubes so they don't appear in the skin sheet.
      const drawModeMeshes = Cube.all
        .filter(isDrawModeCube)
        .map((c) => c.mesh)
        .filter(Boolean);
      drawModeMeshes.forEach((m) => {
        m.visible = false;
      });

      shot(0, 750, W, H, { projection: "orthographic", position: [0, 16, -64], target: [0, 16, 0], zoom: 0.38 });
      label("Front", 165, 1410);
      shot(W, 750, 200, H, { projection: "orthographic", position: [64, 16, 0], target: [0, 16, 0], zoom: 0.38 });
      label("Left", 430, 1410);
      shot(530, 750, W, H, { projection: "orthographic", position: [0, 16, 64], target: [0, 16, 0], zoom: 0.38 });
      label("Back", 695, 1410);
      shot(860, 750, 200, H, { projection: "orthographic", position: [-64, 16, 0], target: [0, 16, 0], zoom: 0.38 });
      label("Right", 960, 1410);
      shot(1060, 945, W, W, { projection: "orthographic", position: [0, 64, 0], target: [0, 0, 0], zoom: 0.38 });
      label("Top", 1225, 1280);
      shot(1390, 945, W, W, { projection: "orthographic", position: [0, -64, 0], target: [0, 0, 0], zoom: 0.38 });
      label("Bottom", 1555, 1280);

      await Promise.all(promises);

      // Restore draw-mode cube visibility.
      drawModeMeshes.forEach((m) => {
        m.visible = true;
      });

      if (capeTex) {
        Object.assign(armorPieces, armorWas);
        rebuildArmorCubes();
        if (playingAnimWas) {
          playingAnimWas.select();
          Timeline.start();
        }
        if (!wasAnimate) Modes.options.edit.select();
      }

      ctx.font = "44px sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = colMid;
      ctx.fillText("Blockbench (PCK Skin Helper)", 112, canvas.height - 48);
      ctx.font = "56px icomoon";
      ctx.fillText("\uE912", 48, canvas.height - 39);

      settings.shading.value = shadingWas;
      settings.brightness.value = brightnessWas;
      Canvas.updateShading();
      offscreen.remove && offscreen.remove();

      return canvas.toDataURL("image/png");
    })();

    Blockbench.export({
      type: "PNG Image",
      extensions: ["png"],
      name: `${skinName}_SkinSheet`,
      content: skinSheetDataUrl,
      savetype: "image",
    });
  }

  track(
    new ModelFormat({
      id: "pck_skin",
      name: "PCK Skin Model (.PSM)",
      description: "Import or create a Skin then export it to PCK Studio",
      target: "PCK Studio",
      icon: "icon-player",
      show_on_start_screen: true,
      can_convert_to: false,
      rotate_cubes: false,
      box_uv: true,
      per_texture_uv_size: true,
      optional_box_uv: false,
      single_texture: false,
      bone_rig: true,
      centered_grid: true,
      animated_textures: false,
      animation_mode: true,
      locators: true,
      model_identifier: false,
      codec: Codecs.project,
      onActivation() {
        Modes.options.animate.name = "Preview";
      },
      onDeactivation() {
        Modes.options.animate.name = tl("mode.animate");
      },
    }),
  );

  Formats.pck_skin.new = function () {
    if (!newProject(this)) return false;

    Project.pck_skin_pack_uuid = guid();
    Project.psm_anim_flags = 0x40000; // RESOLUTION_64x64 checked by default

    Project.texture_width = 64;
    Project.texture_height = 64;

    buildTemplateSkeleton();

    // new_project fires before psm_anim_flags is set, so the panel synced to 0.
    // Push the correct default value now that the project is fully initialised.
    const animPanel = Interface.Panels.pck_anim;
    if (animPanel && animPanel.inside_vue) {
      animPanel.inside_vue.anim_flags = Project.psm_anim_flags;
    }

    const defaultTex = new Texture({ name: "skin" });
    defaultTex.fromDataURL(_DEFAULT_SKIN_B64);
    defaultTex.add();

    const defaultCapeTex = new Texture({ name: "cape" });
    defaultCapeTex.fromDataURL(CAPE_TEXTURE_B64);
    defaultCapeTex.add();

    new Dialog({
      id: "pck_skin_new_name",
      title: "New PCK Skin",
      form: {
        name: { label: "Skin Name", type: "text", value: "skin" },
      },
      onConfirm({ name }) {
        const sanitised = (name || "skin").trim() || "skin";
        Project.name = sanitised;
        Canvas.updateAll();
      },
    }).show();

    return true;
  };

  if (StartScreen && StartScreen.vue) {
    StartScreen.vue.$forceUpdate();
  }

  track(
    new Property(ModelProject, "string", "pck_skin_pack_uuid", {
      exposed: false,
      condition: { formats: ["pck_skin"] },
      default: () => guid(),
    }),
  );

  track(
    new Property(ModelProject, "number", "psm_anim_flags", {
      exposed: false,
      condition: { formats: ["pck_skin"] },
      default: 0,
    }),
  );

  const _DEFAULT_SKIN_B64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAGlQTFRFAAAAKBsLLB8OjFs/OCUSfU0xsHROIBUHRCwXwoZrzJF216OL////QiYdXjIqfz83Dw0UFRMcNzc3KigoPz8/HRooIR0w0tLhycfb8fHwvyUpKiY4q6XBKDQamyIavbrTUVFRdXV17TAsPTNTLwAAACN0Uk5TAP////////////////////////////////////////////+k8FOOAAADn0lEQVR4nO1X227cNhCdEUll0TgXJ3EL5CH//1V9KVCgaW527ToWKTLnDKm1rF1ntTZSIEC1K1G8Hc6NnCOVdqlowaN0rT7Kuku3L9qN2mUAECI/AMDloviFUqvD8RIUvBf1DwbAn0p0o6ngjgboBDYsDiW1d3I8AAzIijqrjg/wghTYERIQYVzvBaXz+wHPzicBgvQDWtBjraUcBED89BIlRCyeO/yCcKJjCZEOAlB3YQQFh4XHJKy7jK5AsVZIQIkxdmOxLOWr9JE6qWmhkleogPCD8TsdxZU8FolqMQmgIPEgAPyvoeNGAky0MsdCw0rEPRxU4cnQF9Pe3TyTi81o7zr0AybLGgDnmt9dxCTg1DhAGHiU6WA8WCC95DmgpfvQGs/OgTLKi+SBgPtzaz/F+w0EHJYA7HBZy6fW+OtHK17TFHTl3xMw3q8QW9f7AHQmwdEAVMHPJDjrLuCO53mVCqdwIwexYEmrIyi/jK9zjrZCQZjXvqlfZ6B6SiG9lkQcjE6sB4RHLpEK+Am6qcN+P1NLz6JNRNSwHbGMdZJ3iMruGpM9QzoG9GC3IeQi+1nMAdhQARi8WCHK09h5TSYNGlKwucLQrgAS398BGGwgh0jPYE7el3Hz1QKbYv/C4DaESQK5C8DjALbiioGrRunDVZUGM6O9cIhWFVncVYHtUMEMZYZP3ppRS4D3VtRjqhqxyBbg1IxXJlu32DCDSYUrsGFJi02ln+cABLbRDcO8Ffo4TWJ3D8fy0NMncoP8l/+a+t7kDD8msaPhRC41Na/2Vd/J/5fYrxi0fVxvAfDIz/Wc+egE9zl1hM4lNH2luvLKhqe6u53f7gd9RbH05B+KRRCTxdvUKWxt5o2YlZItj7Z/55vpMdf/AD8W4O3m98cBvEt/Pg5g3fUTATAnYBO0/ZHk9jzw27xzJ4ksr9/uOw+mibIF+kEq/LcAy2S7L6l+F2CZ7vel9YMAc8JxNMCS8hylwj6+oI0b7IuTvQCkC9J4wMQHZEF37gU4SzWpASFMfEFDzc7M8e/XATCNAwBZe+IDxjBmvOB+gGiJqCcA+UJofEBqbQ2AcHwgQM1PlQ+oURyRVSo0whBuSVWpdA15+qARqxu1MQ5Z8oI6idm8nQ8754HxKi6Z7COubNr+l8V5sK0vz4M3/O4iYSid8QWm9VtmIDvRuKOC8YUX5WLiC3+w0dUcXzTtfE/uABhfeHZZJr5wwaV9JQe40lKCbwlsVIdTtMy7AAAAAElFTkSuQmCC";

  const ARMOR_TEXTURE_B64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAJBQTFRFAAAAL8u5K7yqMdXDLca0MM69M9rJL827vJhin4RNtJBa////O/noOfPiOvjnc145PP/uO/vqNeXUOfXkNunYN+vZKbajaVQzLsi2OPHgN+3bOO/eNePRLcSyLMKwK76sMtjHMtfFMdPBMNC+LMGvKrimNufWPP3sKrqoNOHPfGI+TD0mM93LNN/NKLCeKbShtm5DLgAAADB0Uk5TAP//////////////////////////////////////////////////////////////ys+fXQAABEdJREFUeJztl31T4kgQh3smM0kIAaO8iBJA0PXWu/3+X+Tqaq3bVZDwFgTlVZJJMnMJqOuFzSL355VTBZWapJ/8uqe7J4PgeaDNYAJ+PVQU/gnAQjybvdyQ6Rqy8nYBAFMP1tZIIP4WQBH4dOnuBEQmCKgLmP9bgUSZgtBwB+AYwHlBRZevgJLHdOSkeu+MQSgf5NBd/go44j4GTqa7AKlnuw0HfiiQ074OjKc7uxTAxvfQYh2uVwD1QT5QOpX2DsDB2vcoDs8xqLkwMru4CKRVFz3TMkN9+K6OhEutyhPIceDaXAnTBYcPrldeAxoQOLrVcJYdLiRqgwweeQIKhpjrw2ArBpHzOPJfdkP9iMom9NOIa3e1FepXbKapLpFUO9CyCx27xve4gvWb0Yv3ApWQNGXHVPhtSBdaoBwCHRyAYqMCU2Ygjm/iMVCdyA3n2R0HNZrw2/XmniSx54Dyao8dQlQYhebPYrDOAgaIv1mF+EBw4gXHj3Y8LzSxXj60CcObVN4etNwzb7dm17UQZWJoy+EXCpLGAUB5DLlxlAj5URiDfYzr2NIfYnN7AT5b1XG8WvcCVFeUxDNzL0ADtXh8VbYAZ/oCd80ofRSzVZtPRSVaiXPervNmvVPGy0czZWfuardJAKJkB6CdfIdzm+mu5AaKX3E7GivfQ6FP4ElS4MR9AN+NA66c1iYzSjAgMoTeSgUx9ZZYhqzD6Opwjs+WtrSq2Lgowt9NHNDolq2oI9M8MzpEEyuDjc5mbh7bZldRvPy3Q6K182xSGyo5/wFOvsYBpzLDUTeqP6JF6UEFpi9YeQgsMOSwWc+NYRm4lFp2K+2cLDoybLmgVIBERXXVyfBHHXggsjbSyeyyA8Vu2IzjVfm6CvKpVQHr098YHRvX6Az8BAVWEuBLkz6ZtqIbNymtL2ujz/sqqC5VFS9gJLLKUKp3iwJZ6NyixWGQHgeE898tpIatSUpqtgid8kHDyvlTGdhlV733o1kSdr5Mf5N00lUwH/6krl8AjRHQ7BB5+bkupYfI2EilOY23kmxiCiqiVxPQM9sgxNVKJL4qCbDn8x+AD8AH4H8OOA8y3fi+vxdAUlFi130X4Kr/Y6v6T4Cz1E0Q/yJ9N+CCkZmuf8XVznEPqpPyn/sCGs68KO6heFuSunLOG+06L2wB0MnC9dPSDFJ0QopivOvMtAUgKZS/0zIaTGXlyYPZrlPbFiAXoBkuAJcfSbnn83xrXwDNLxjPMsaLR1P0IBl7A2QZH8EDmeCUZF6naO7bvoAvHXgyHUc3eqD1C94Ik8Lgj78kDqVOQZGXuuWvd2crKTaoSpoN3GZEXDR96XKJmhpyq4Po8ODnurIx9LXwKQnySZvuVjVeTJQeVnGWA8t0VXV83jtADtNHiQriE415MGlMHBLeMtqpcvN0hAUiKh+8F1ANnIyVpovTibeseE7Jdd15+LG1SqqVfwCBMN/1WD7yYQAAAABJRU5ErkJggg==";

  function pckLoadThreeTexture(dataUrl, uvHeight) {
    const img = new Image();
    img.src = dataUrl;
    const map = new THREE.Texture(img);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    img.onload = function () {
      map.needsUpdate = true;
    };
    return {
      visible: true,
      map,
      img,
      uv_width: 64,
      uv_height: uvHeight !== undefined ? uvHeight : 64,
      frameCount: 1,
      getMaterial() {
        return { map: this.map };
      },
    };
  }

  const armorThreeTex = pckLoadThreeTexture(ARMOR_TEXTURE_B64, 64);

  const CAPE_TEXTURE_B64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAMAAACVQ462AAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHVQTFRFAAAAUsf/HnbbC7L/JIv/Ob7/ECFF/wCt/wBFECFSECF4ECFmAP8F//IAEDOHrQ3//7UA7B0b6urszm3/zs/OSklKEDOZuF0mqFIhl0kbEDOtvbu9Px0LECGHEDO6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUIN0rAAAACd0Uk5TAP/////////////////////////////////////////rBvoV5hDw0wScPwAAAdFJREFUeJzdk2Fv2jAQht87G0iBrZRJ2/hUbdP+//+ZpqlfJqVVVdo1VAHO59lJ05LgVJHYp53AOr2yn9y9PhMITbxm+pKZJnFIB1lqdrPnF3l3QOg72gCMKkOsjpzn5ntud7DlWeR9DwCkLID15NnGPjwgh4BR+IsVThNiC2cbzAswR4CV+GsBMGIVxshpqhmyXo3D+z84f6QegCG3oEfvuA/ALMs7630A2EqUTgV4FyxYaw+AdBlcH+OWiTMgQwmU7Qp4uR9Tfr5J9RAAC68g7+0dTQwyCynhNm0APlDORGnAhXcEF+7KrMfzch60IiueWi1U1xS8SfUQAXGS/BS7AEA0QdAFKBa0Dj4kAZ/dFowJnM1XWwQbRTD5ra1NuAinH8TieBQiQOtXYPNpVl2DSPkkLRP0Y3Dx5mybBPhVXZi59r0Alk+UW+9sEoBVleXGTV896AJihao9APDswcY++gFZEW204tMAUPWmabx4Vu93LUAc5trGBOBIqcJ2AKiG8fYUwCwL5xODMAwQCERiZsUJALCEBzsYwNoRTK0NBgyP/wJwGZYrfNG4HuZff+EbuSp9G1Bt/Jlav++v6nRIBceAS0x+YAjgH1Vwggcnxl/vDAIw3U5TQgAAAABJRU5ErkJggg==";

  let _capeThreeTexCache = null;
  let _capeThreeTexSrc = null;

  // Cape = whatever texture sits in slot 1 (index 1) — no name matching.
  function _isCapeTexture(t) {
    return !!t && t === Texture.all[1];
  }

  function _buildCapeThreeTex() {
    const capeTex = Texture.all[1] || null;
    if (capeTex) {
      const mat = capeTex.getMaterial && capeTex.getMaterial();
      const threeMap = (mat && (mat.map || (mat.uniforms && mat.uniforms.map && mat.uniforms.map.value))) || null;
      if (threeMap) {
        const cacheKey = capeTex.uuid;
        if (_capeThreeTexCache && _capeThreeTexSrc === cacheKey) return _capeThreeTexCache;
        _capeThreeTexSrc = cacheKey;
        _capeThreeTexCache = {
          visible: true,
          map: threeMap,
          uv_width: 64,
          uv_height: 32,
          frameCount: 1,
          getMaterial() {
            return { map: this.map };
          },
        };
        return _capeThreeTexCache;
      }
    }
    if (_capeThreeTexCache && _capeThreeTexSrc === null) return _capeThreeTexCache;
    _capeThreeTexSrc = null;
    _capeThreeTexCache = pckLoadThreeTexture(CAPE_TEXTURE_B64, 32);
    return _capeThreeTexCache;
  }

  function getCapeThreeTex() {
    return _buildCapeThreeTex();
  }

  function _invalidateCapeThreeTexCache() {
    _capeThreeTexCache = null;
    _capeThreeTexSrc = null;
  }

  function getPckSkinTexture() {
    return Texture.all[0] || null;
  }

  const PCK_VERT = `
varying vec2 vUv;
varying float light;
varying float lift;
uniform bool SHADE;
float AMBIENT = 0.6;
float XFAC = 0.075;
float ZFAC = 0.175;
void main() {
  if (SHADE) {
    vec3 N = vec3(modelMatrix * vec4(normal, 0.0));
    float yLight = (1.0 - N.z) * 0.5;
    light = yLight * (1.0 - AMBIENT) + N.x*N.x * XFAC + N.y*N.y * ZFAC + AMBIENT;
  } else { light = 1.0; }
  lift = (color.b == 1.25) ? 0.1 : 0.0;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

  const PCK_FRAG = `
#ifdef GL_ES
precision highp float;
#endif
uniform sampler2D t0;
uniform bool SHADE;
uniform float FRAMES;
varying vec2 vUv;
varying float light;
varying float lift;
void main(void) {
  vec2 uVa = vUv;
  if (FRAMES > 1.0) { uVa = vec2(vUv.x, vUv.y * FRAMES); }
  vec4 tx = texture2D(t0, uVa);
  gl_FragColor = vec4(lift + tx.rgb * light, tx.a);
  if (gl_FragColor.a < 0.05) discard;
}`;

  function pckBuildMaterial(texObj) {
    const map = texObj
      ? texObj.getMaterial
        ? texObj.getMaterial().map || texObj.getMaterial().uniforms?.map?.value || null
        : null
      : null;
    const uniforms = {
      SHADE: { type: "bool", value: settings.shading.value },
      FRAMES: { type: "int", value: texObj && texObj.frameCount > 1 ? texObj.frameCount : 1 },
      t0: { type: "t", value: map },
    };
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PCK_VERT,
      fragmentShader: PCK_FRAG,
      side: Canvas.getRenderSide ? Canvas.getRenderSide() : THREE.FrontSide,
      vertexColors: THREE.FaceColors,
      transparent: true,
    });
  }

  const _origUpdateFaces = Cube.preview_controller.updateFaces;
  Cube.preview_controller.updateFaces = function (cube) {
    _origUpdateFaces.call(this, cube);
    if (Format.id !== "pck_skin" || Project.view_mode !== "textured") return;

    const mesh = cube.mesh;
    if (!mesh) return;

    if (cube.uuid.startsWith("eeeeeeee")) {
      mesh.material = pckBuildMaterial(armorThreeTex);
    } else if (cube.uuid.startsWith("cccccccc")) {
      mesh.material = pckBuildMaterial(getCapeThreeTex());
    } else {
      const skinTex = getPckSkinTexture();
      mesh.material = pckBuildMaterial(skinTex);
    }
  };

  const _origUpdateShading = Canvas.updateShading;
  Canvas.updateShading = function (...args) {
    _origUpdateShading.apply(this, args);
    if (Format.id !== "pck_skin") return;
    const shadeVal = settings.shading.value;
    Cube.all.forEach((cube) => {
      const mat = cube.mesh && cube.mesh.material;
      if (mat && mat.uniforms && mat.uniforms.SHADE !== undefined) {
        mat.uniforms.SHADE.value = shadeVal;
      }
    });
    // Also update ghost mesh shading
    _templateGhostRoot.traverse((child) => {
      if (child.material && child.material.uniforms && child.material.uniforms.SHADE !== undefined) {
        child.material.uniforms.SHADE.value = shadeVal;
      }
    });
  };

  // Patch Canvas.updateAll so ghost meshes are re-parented after Blockbench
  // rebuilds bone Three.js objects (which orphans any previously attached children).
  const _origUpdateAll = Canvas.updateAll;
  Canvas.updateAll = function (...args) {
    _origUpdateAll.apply(this, args);
    if (Format && Format.id === "pck_skin") {
      requestAnimationFrame(() => rebuildTemplateGhosts());
    }
  };

  const CAPE_UV_STUB = {
    uv_width: 64,
    uv_height: 32,
    getUVWidth() {
      return 64;
    },
    getUVHeight() {
      return 32;
    },
  };

  // Armor cubes always use a 64×64 UV space regardless of the project's skin
  // texture dimensions. Returning null from getTexture() caused the UV panel
  // to fall back to the project texture (which may be 64×32), breaking the UV
  // mapping. This stub locks the UV space to 64×64 so all UV calculations stay
  // correct even on 64×32 skin projects.
  const ARMOR_UV_STUB = {
    uv_width: 64,
    uv_height: 64,
    getUVWidth() {
      return 64;
    },
    getUVHeight() {
      return 64;
    },
  };

  const _origGetTexture = CubeFace.prototype.getTexture;
  CubeFace.prototype.getTexture = function (...args) {
    if (Format.id === "pck_skin" && this.cube) {
      if (this.texture === null) return null;
      if (this.cube.uuid.startsWith("eeeeeeee")) return ARMOR_UV_STUB;
      if (this.cube.uuid.startsWith("cccccccc")) return CAPE_UV_STUB;
      return getPckSkinTexture() || _origGetTexture.call(this, ...args);
    }
    return _origGetTexture.call(this, ...args);
  };

  track({
    delete() {
      Cube.preview_controller.updateFaces = _origUpdateFaces;
      CubeFace.prototype.getTexture = _origGetTexture;
      Canvas.updateShading = _origUpdateShading;
      Canvas.updateAll = _origUpdateAll;
      Canvas.updateAllFaces();
    },
  });

  const _onTextureUpdate = ({ texture }) => {
    if (Format.id !== "pck_skin") return;
    if (texture && _isCapeTexture(texture)) _invalidateCapeThreeTexCache();
    Canvas.updateAllFaces();
    rebuildTemplateGhosts();
  };
  const _onTextureRemoved = ({ texture }) => {
    if (Format.id !== "pck_skin") return;
    if (texture && _isCapeTexture(texture)) _invalidateCapeThreeTexCache();
    Canvas.updateAllFaces();
    rebuildTemplateGhosts();
  };
  const _onSelectProject = () => {
    if (Format && Format.id === "pck_skin") {
      requestAnimationFrame(() => rebuildTemplateGhosts());
    }
  };
  Blockbench.on("update_texture", _onTextureUpdate);
  Blockbench.on("finish_edit", _onTextureRemoved);
  Blockbench.on("select_project", _onSelectProject);
  track({
    delete() {
      Blockbench.removeListener("update_texture", _onTextureUpdate);
      Blockbench.removeListener("finish_edit", _onTextureRemoved);
      Blockbench.removeListener("select_project", _onSelectProject);
    },
  });

  const armorPieces = { helmet: false, chestplate: false, leggings: false, boots: false, cape: false, elytra: false };

  function armorUuid() {
    return "eeeeeeee" + guid().substr(8);
  }

  function capeUuid() {
    return "cccccccc" + guid().substr(8);
  }

  const PCK_ANIMATIONS = {
    format_version: "1.8.0",
    animations: {
      Idle: {},
      Bob: {
        loop: true,
        bones: {
          ARM0: { rotation: [0.0, 0.0, "(math.cos(query.life_time * 103.2) * 2.865) + 2.865"] },
          ARM1: { rotation: [0.0, 0.0, "-((math.cos(query.life_time * 103.2) * 2.865) + 2.865)"] },
        },
      },
      Walk: {
        loop: true,
        bones: {
          ARM0: { rotation: ["-math.cos(query.anim_time * 360) * 30", 0, 0] },
          ARM1: { rotation: ["math.cos(query.anim_time * 360) * 30", 0, 0] },
          LEG0: { rotation: ["math.cos(query.anim_time * 360) * 1.4 * 30", 0, 0] },
          LEG1: { rotation: ["math.cos(query.anim_time * 360) * -1.4 * 30", 0, 0] },
        },
      },
      Run: {
        loop: true,
        bones: {
          ARM0: { rotation: ["-math.cos(query.anim_time * 720) * 50", 0, 0] },
          ARM1: { rotation: ["math.cos(query.anim_time * 720) * 50", 0, 0] },
          LEG0: { rotation: ["math.cos(query.anim_time * 720) * 1.4 * 50", 0, 0] },
          LEG1: { rotation: ["math.cos(query.anim_time * 720) * -1.4 * 50", 0, 0] },
        },
      },
      Swim: {
        loop: true,
        animation_length: 2.6,
        override_previous_animation: true,
        bones: {
          ARM1: {
            rotation: {
              "0.0": [0, 180, 180],
              0.65: [0, 180, 287.2],
              1.06: [90, 180, 180],
              1.28: [0, 180, 180],
              1.93: [0, 180, 287.2],
              2.34: [90, 180, 180],
              2.6: [0, 180, 180],
            },
          },
          ARM0: {
            rotation: {
              "0.0": [0, 180, -180],
              0.65: [0, 180, -287.2],
              1.06: [90, 180, -180],
              1.28: [0, 180, -180],
              1.93: [0, 180, -287.2],
              2.34: [90, 180, -180],
              2.6: [0, 180, -180],
            },
          },
          root: { rotation: [60, 0, 0], position: [0, 4, 12] },
          LEG1: { rotation: ["math.lerp(0.0, math.cos(query.life_time * 415.4 + 180.0) * 17.2, 1.0)", 0, 0] },
          LEG0: { rotation: ["math.lerp(0.0, math.cos(query.life_time * 415.4) * 17.2, 1.0)", 0, 0] },
          HEAD: { rotation: [-37.5, 0, 0] },
        },
      },
      Sneak: {
        loop: true,
        bones: {
          //  BODY: { position: [0, -2, 0] },
          HEAD: { rotation: [-28, 0, 0], position: [0, -1, 0] },
          ARM1: { rotation: ["-5.7 + math.cos(query.anim_time * 180) * 12", 0, 0] },
          LEG1: { rotation: ["math.cos(query.anim_time * 180) * -16", 0, 0] },
          ARM0: { rotation: ["-5.7 + math.cos(query.anim_time * 180) * -12", 0, 0] },
          LEG0: { rotation: ["math.cos(query.anim_time * 180) * 16", 0, 0] },
          WAIST: { rotation: [28, 0, 0] },
        },
      },
      "Bad Santa": {
        loop: true,
        bones: {
          WAIST: { position: [0, -10, 0] },
          LEG0: { rotation: ["-88.5 - this", "18 - this", "-this"], position: [0, -10, 0] },
          LEG1: { rotation: ["-88.5 - this", "-18 - this", "0"], position: [0, -10, 0] },
        },
      },
      "Zombie Arms": {
        loop: true,
        bones: {
          ARM0: { rotation: [-90, 0, 0] },
          ARM1: { rotation: [-90, 0, 0] },
        },
      },
      "Statue of Liberty": {
        loop: true,
        bones: {
          ARM0: { rotation: [180, 0, -17.2] },
        },
      },
      "Backwards Crouch": {
        loop: true,
        bones: {
          WAIST: { rotation: [-28, 0, 0] },
          //  BODY: { position: [0, -2, 0] },
          HEAD: { rotation: [-28, 0, 0], position: [0, -1, 0] },
          // ARM0: { rotation: ["5.7 + math.cos(query.anim_time * 180) * -12", 0, 0] },
          // ARM1: { rotation: ["5.7 + math.cos(query.anim_time * 180) * 12", 0, 0] },
          // LEG0: { rotation: ["math.cos(query.anim_time * 180) * 16", 0, 0] },
          // LEG1: { rotation: ["math.cos(query.anim_time * 180) * -16", 0, 0] },
        },
      },
      Dinnerbone: {
        loop: true,
        bones: {
          ROOT: { position: [0, 32, 0], rotation: [0, 0, 180] },
        },
      },
    },
  };

  function clearArmorCubes() {
    if (!Project.pck_armor_cubes) return;
    Project.pck_armor_cubes.slice().forEach((c) => {
      if (Cube.all.includes(c)) c.remove();
    });
    Project.pck_armor_cubes = [];
  }

  const BONE_DEFAULT_PIVOTS = {
    HEAD: [0, 24, 0],
    BODY: [0, 24, 0],
    WAIST: [0, 12, 0],
    ARM0: [6, 22, 0],
    ARM1: [-6, 22, 0],
    LEG0: [2, 12, 0],
    LEG1: [-2, 12, 0],
  };

  // ── Armor Locators ─────────────────────────────────────────────────────────
  // One locator per armor attachment point that has no corresponding bone/folder
  // of its own. WAIST is excluded — it is already a real skeleton Group whose
  // pivot encodes the PSM offset directly (waistGroup.origin[1] = 12 + value).
  //
  // parentBone  = the Blockbench Group the locator lives under
  // defaultPos  = world-space position of the locator at rest
  const ARMOR_LOCATORS = [
    { name: "HELMET", parentBone: "HEAD", defaultPos: [0, 24, 0] },
    { name: "CHEST", parentBone: "BODY", defaultPos: [0, 24, 0] },
    { name: "SHOULDER0", parentBone: "ARM0", defaultPos: [6, 22, 0] },
    { name: "SHOULDER1", parentBone: "ARM1", defaultPos: [-6, 22, 0] },
    { name: "PANTS0", parentBone: "LEG0", defaultPos: [2, 12, 0] },
    { name: "PANTS1", parentBone: "LEG1", defaultPos: [-2, 12, 0] },
    { name: "BOOT0", parentBone: "LEG0", defaultPos: [2, 12, 0] },
    { name: "BOOT1", parentBone: "LEG1", defaultPos: [-2, 12, 0] },
  ];

  // UUID prefix that tags every armor locator for easy identification.
  const ARMOR_LOCATOR_UUID_PREFIX = "llllllll";

  function isArmorLocator(obj) {
    return obj instanceof Locator && typeof obj.uuid === "string" && obj.uuid.startsWith(ARMOR_LOCATOR_UUID_PREFIX);
  }

  function armorLocatorUuid() {
    return ARMOR_LOCATOR_UUID_PREFIX + guid().substr(8);
  }

  // Returns the world-space position delta of the named armor locator vs its
  // default position, or [0,0,0] if the locator doesn't exist yet.
  function getArmorLocatorOffset(locatorName) {
    const def = ARMOR_LOCATORS.find((l) => l.name === locatorName);
    if (!def) return [0, 0, 0];
    const loc = Locator.all.find((l) => l.name === locatorName && isArmorLocator(l));
    if (!loc) return [0, 0, 0];
    return [
      loc.position[0] - def.defaultPos[0],
      loc.position[1] - def.defaultPos[1],
      loc.position[2] - def.defaultPos[2],
    ];
  }

  // Create all armor locators and parent them to their respective bones.
  // Called once from buildTemplateSkeleton().
  function buildArmorLocators() {
    ARMOR_LOCATORS.forEach((def) => {
      const bone = Group.all.find((g) => g.name === def.parentBone);
      if (!bone) return;
      const loc = new Locator({ name: def.name, position: def.defaultPos.slice() }, armorLocatorUuid());
      loc.addTo(bone).init();
    });
  }

  // Remove all armor locators (used on close/unload).
  function clearArmorLocators() {
    Locator.all.filter(isArmorLocator).forEach((l) => l.remove());
  }

  // Maps ANIM flag masks to the animation name they should lock in Preview.
  const ANIM_FLAG_LOCK_MAP = [
    { mask: 0x2, name: "Zombie Arms" },
    { mask: 0x8, name: "Bad Santa" },
    { mask: 0x80, name: "Statue of Liberty" },
    { mask: 0x20000, name: "Backwards Crouch" },
    { mask: 0x80000000, name: "Dinnerbone" },
  ];

  function syncLockedAnims() {
    if (!Modes.animate) return;
    const flags = Project.psm_anim_flags || 0;

    // Find the first active flag with a matching animation.
    let lockTarget = null;
    for (const entry of ANIM_FLAG_LOCK_MAP) {
      if ((flags & entry.mask) !== 0) {
        const anim = Animation.all.find((a) => a.name === entry.name);
        if (anim) {
          lockTarget = anim;
          break;
        }
      }
    }

    if (lockTarget) {
      lockTarget.select();
      Timeline.start();
      Timeline.stay = true;
    } else {
      Timeline.stay = false;
      Timeline.pause();
    }
  }

  // Rebuilds ghost meshes respecting the current psm_anim_flags.
  // Called whenever ANIM flag checkboxes change.
  function syncTemplateCubeVisibility() {
    if (Format.id !== "pck_skin") return;
    rebuildTemplateGhosts();
  }

  // Rebuilds ghost meshes after PSM import / flag changes.
  function restoreTemplateCubes() {
    if (Format.id !== "pck_skin") return;
    rebuildTemplateGhosts();
  }

  function rebuildArmorCubes() {
    clearArmorCubes();
    if (!Modes.animate) return;
    if (!Project.pck_armor_cubes) Project.pck_armor_cubes = [];

    // Place one armor cube, shifted by the current locator offset so the piece
    // tracks wherever the user has moved the corresponding armor locator.
    function addCube(def, boneName, uuidFn = armorUuid, locatorName = null) {
      const bone = Group.all.find((g) => g.name === boneName);
      if (!bone) return;

      // Read the delta from the armor locator (defaults to [0,0,0]).
      const [dx, dy, dz] = locatorName ? getArmorLocatorOffset(locatorName) : [0, 0, 0];

      const shifted = Object.assign({}, def);
      if (shifted.from) shifted.from = [shifted.from[0] + dx, shifted.from[1] + dy, shifted.from[2] + dz];
      if (shifted.to) shifted.to = [shifted.to[0] + dx, shifted.to[1] + dy, shifted.to[2] + dz];
      if (shifted.origin) shifted.origin = [shifted.origin[0] + dx, shifted.origin[1] + dy, shifted.origin[2] + dz];

      const cube = new Cube(Object.assign({ box_uv: true, export: false }, shifted), uuidFn()).addTo(bone).init();
      Project.pck_armor_cubes.push(cube);
    }

    if (armorPieces.helmet) {
      addCube(
        { name: "armorHelmet", from: [-4, 24, -4], to: [4, 32, 4], inflate: 1, uv_offset: [0, 0], color: 1 },
        "HEAD",
        armorUuid,
        "HELMET",
      );
    }
    if (armorPieces.chestplate) {
      addCube(
        { name: "armorBody", from: [-4, 12, -2], to: [4, 24, 2], inflate: 1.01, uv_offset: [16, 16], color: 1 },
        "BODY",
        armorUuid,
        "CHEST",
      );
      addCube(
        {
          name: "armorRightArm",
          from: [-8, 12, -2],
          to: [-4, 24, 2],
          inflate: 1,
          uv_offset: [40, 16],
          color: 1,
          mirror_uv: true,
        },
        "ARM1",
        armorUuid,
        "SHOULDER1",
      );
      addCube(
        {
          name: "armorLeftArm",
          from: [4, 12, -2],
          to: [8, 24, 2],
          inflate: 1,
          uv_offset: [40, 16],
          color: 1,
        },
        "ARM0",
        armorUuid,
        "SHOULDER0",
      );
    }
    if (armorPieces.leggings) {
      addCube(
        { name: "armorLegsBody", from: [-4, 12, -2], to: [4, 24, 2], inflate: 0.51, uv_offset: [16, 48], color: 1 },
        "WAIST",
        armorUuid,
        null,
      );
      addCube(
        { name: "armorRightLeg", from: [-4, 0, -2], to: [0, 12, 2], inflate: 0.5, uv_offset: [0, 48], color: 1 },
        "LEG1",
        armorUuid,
        "PANTS1",
      );
      addCube(
        {
          name: "armorLeftLeg",
          from: [0, 0, -2],
          to: [4, 12, 2],
          inflate: 0.5,
          uv_offset: [0, 48],
          color: 1,
          mirror_uv: true,
        },
        "LEG0",
        armorUuid,
        "PANTS0",
      );
    }
    if (armorPieces.boots) {
      addCube(
        { name: "rightBoot", from: [-4, 0, -2], to: [0, 6, 2], inflate: 1, uv_offset: [0, 22], color: 1 },
        "LEG1",
        armorUuid,
        "BOOT1",
      );
      addCube(
        {
          name: "leftBoot",
          from: [0, 0, -2],
          to: [4, 6, 2],
          inflate: 1,
          uv_offset: [0, 22],
          color: 1,
          mirror_uv: true,
        },
        "LEG0",
        armorUuid,
        "BOOT0",
      );
    }

    if (armorPieces.elytra) {
      addCube(
        {
          name: "elytraRight",
          from: [-4.75, 4, 1],
          to: [5.25, 24, 3],
          origin: [0.25, 24, 2],
          rotation: [-10, -1, 12.5],
          uv_offset: [22, 0],
          mirror_uv: true,
          color: 1,
        },
        "BODY",
        capeUuid,
      );
      addCube(
        {
          name: "elytraLeft",
          from: [-5.25, 4, 1],
          to: [4.75, 24, 3],
          origin: [-0.25, 24, 2],
          rotation: [-10, 1, -12.5],
          uv_offset: [22, 0],
          mirror_uv: false,
          color: 1,
        },
        "BODY",
        capeUuid,
      );
    }
    if (armorPieces.cape) {
      addCube(
        {
          name: "cape",
          from: [-5, 8, 3],
          to: [5, 24, 4],
          origin: [0, 24, 3],
          rotation: [12.5, 180, 0],
          uv_offset: [0, 0],
          mirror_uv: false,
          color: 1,
        },
        "BODY",
        capeUuid,
      );
    }

    Canvas.updateAllUVs();
    updateSelection();
  }

  function onSelectMode({ mode }) {
    if (Format.id !== "pck_skin" || mode.id !== "animate") return;
    Animator.animations.forEachReverse((a) => a.remove(false));
    Animator.loadFile({ json: PCK_ANIMATIONS });
    if (Animation.all[0]) Animation.all[0].select();
    rebuildArmorCubes();
    syncLockedAnims();
  }

  function onUnselectMode({ mode }) {
    if (Format.id !== "pck_skin" || mode.id !== "animate") return;
    Animator.animations.forEachReverse((a) => a.remove(false));
    clearArmorCubes();
    Canvas.updateAllFaces();
  }

  Blockbench.on("select_mode", onSelectMode);
  Blockbench.on("unselect_mode", onUnselectMode);

  track({
    delete() {
      Blockbench.removeListener("select_mode", onSelectMode);
      Blockbench.removeListener("unselect_mode", onUnselectMode);
    },
  });

  const pckStyleEl = document.createElement("style");
  pckStyleEl.type = "text/css";
  pckStyleEl.appendChild(
    document.createTextNode(`
.pck_anim_list {
    padding: 4px 6px;
    max-height: 320px;
    overflow-y: auto;
}
.pck_anim_list div {
    display: flex;
    align-items: center;
    padding: 1px 0;
}
.pck_anim_group_label {
    font-size: 0.78em;
    font-weight: bold;
    text-transform: uppercase;
    color: var(--color-subtle_text);
    letter-spacing: 0.06em;
    padding: 4px 0 1px 2px !important;
}
.pck_anim_separator {
    height: 5px !important;
}
.pck_anim_list input {
    margin: 0 4px 0 2px;
    flex-shrink: 0;
}
.list.pck_armor_list {
    padding: 6px;
}
.panel#panel_pck_preview .list .list_inner_two_columns,
#pck_preview .list .list_inner_two_columns {
    column-count: 2;
}
.panel#panel_pck_preview input,
#pck_preview input {
    margin: -4px 4px;
}
`),
  );
  document.getElementsByTagName("head")[0].appendChild(pckStyleEl);
  track({
    delete() {
      pckStyleEl.remove();
    },
  });

  // ── ANIM Flags Panel ─────────────────────────────────────────────────────

  track(
    new Panel({
      id: "pck_anim",
      name: "ANIM Flags",
      icon: "animation",
      condition: { modes: ["edit"], formats: ["pck_skin"] },
      component: {
        name: "panel-pck_anim",
        data() {
          return { anim_flags: Project.psm_anim_flags || 0 };
        },
        methods: {
          toggleFlag(mask) {
            this.anim_flags ^= mask;
            // Slim Model (0x80000) and 64×64 Resolution (0x40000) are mutually
            // exclusive — toggling Slim on must uncheck 64×64.
            if (mask === 0x80000 && (this.anim_flags & 0x80000) !== 0) {
              this.anim_flags &= ~0x40000;
            }
            Project.psm_anim_flags = this.anim_flags;
            syncTemplateCubeVisibility();
            syncLockedAnims();
          },
          syncFromProject() {
            this.anim_flags = Project.psm_anim_flags || 0;
            syncLockedAnims();
          },
        },
        mounted() {
          this._syncListener = () => this.syncFromProject();
          Blockbench.on("load_project", this._syncListener);
          Blockbench.on("select_project", this._syncListener);
          Blockbench.on("new_project", this._syncListener);
        },
        beforeDestroy() {
          Blockbench.removeListener("load_project", this._syncListener);
          Blockbench.removeListener("select_project", this._syncListener);
          Blockbench.removeListener("new_project", this._syncListener);
        },
        template:
          '<div><div class="list pck_anim_list"><div class="pck_anim_group_label">Arms</div><div><input type="checkbox" id="pck_anim_STATIC_ARMS" :checked="(anim_flags & 1) !== 0" @change="toggleFlag(1)"><label for="pck_anim_STATIC_ARMS">Static Arms</label></div><div><input type="checkbox" id="pck_anim_ZOMBIE_ARMS" :checked="(anim_flags & 2) !== 0" @change="toggleFlag(2)"><label for="pck_anim_ZOMBIE_ARMS">Zombie Arms</label></div><div><input type="checkbox" id="pck_anim_SYNCED_ARMS" :checked="(anim_flags & 64) !== 0" @change="toggleFlag(64)"><label for="pck_anim_SYNCED_ARMS">Synced Arms</label></div><div><input type="checkbox" id="pck_anim_STATUE_OF_LIBERTY" :checked="(anim_flags & 128) !== 0" @change="toggleFlag(128)"><label for="pck_anim_STATUE_OF_LIBERTY">Statue of Liberty</label></div><div><input type="checkbox" id="pck_anim_RIGHT_ARM_DISABLED" :checked="(anim_flags & 2048) !== 0" @change="toggleFlag(2048)"><label for="pck_anim_RIGHT_ARM_DISABLED">Right Arm Disabled</label></div><div><input type="checkbox" id="pck_anim_LEFT_ARM_DISABLED" :checked="(anim_flags & 4096) !== 0" @change="toggleFlag(4096)"><label for="pck_anim_LEFT_ARM_DISABLED">Left Arm Disabled</label></div><div><input type="checkbox" id="pck_anim_RIGHT_ARM_OVERLAY_DISABLED" :checked="(anim_flags & 2097152) !== 0" @change="toggleFlag(2097152)"><label for="pck_anim_RIGHT_ARM_OVERLAY_DISABLED">Right Arm Overlay Off</label></div><div><input type="checkbox" id="pck_anim_LEFT_ARM_OVERLAY_DISABLED" :checked="(anim_flags & 1048576) !== 0" @change="toggleFlag(1048576)"><label for="pck_anim_LEFT_ARM_OVERLAY_DISABLED">Left Arm Overlay Off</label></div><div><input type="checkbox" id="pck_anim_FORCE_RIGHT_ARM_ARMOR" :checked="(anim_flags & 67108864) !== 0" @change="toggleFlag(67108864)"><label for="pck_anim_FORCE_RIGHT_ARM_ARMOR">Force Right Arm Armor</label></div><div><input type="checkbox" id="pck_anim_FORCE_LEFT_ARM_ARMOR" :checked="(anim_flags & 134217728) !== 0" @change="toggleFlag(134217728)"><label for="pck_anim_FORCE_LEFT_ARM_ARMOR">Force Left Arm Armor</label></div><div class="pck_anim_separator"></div><div class="pck_anim_group_label">Legs</div><div><input type="checkbox" id="pck_anim_STATIC_LEGS" :checked="(anim_flags & 4) !== 0" @change="toggleFlag(4)"><label for="pck_anim_STATIC_LEGS">Static Legs</label></div><div><input type="checkbox" id="pck_anim_BAD_SANTA" :checked="(anim_flags & 8) !== 0" @change="toggleFlag(8)"><label for="pck_anim_BAD_SANTA">Bad Santa</label></div><div><input type="checkbox" id="pck_anim_SYNCED_LEGS" :checked="(anim_flags & 32) !== 0" @change="toggleFlag(32)"><label for="pck_anim_SYNCED_LEGS">Synced Legs</label></div><div><input type="checkbox" id="pck_anim_RIGHT_LEG_DISABLED" :checked="(anim_flags & 16384) !== 0" @change="toggleFlag(16384)"><label for="pck_anim_RIGHT_LEG_DISABLED">Right Leg Disabled</label></div><div><input type="checkbox" id="pck_anim_LEFT_LEG_DISABLED" :checked="(anim_flags & 32768) !== 0" @change="toggleFlag(32768)"><label for="pck_anim_LEFT_LEG_DISABLED">Left Leg Disabled</label></div><div><input type="checkbox" id="pck_anim_RIGHT_LEG_OVERLAY_DISABLED" :checked="(anim_flags & 8388608) !== 0" @change="toggleFlag(8388608)"><label for="pck_anim_RIGHT_LEG_OVERLAY_DISABLED">Right Leg Overlay Off</label></div><div><input type="checkbox" id="pck_anim_LEFT_LEG_OVERLAY_DISABLED" :checked="(anim_flags & 4194304) !== 0" @change="toggleFlag(4194304)"><label for="pck_anim_LEFT_LEG_OVERLAY_DISABLED">Left Leg Overlay Off</label></div><div><input type="checkbox" id="pck_anim_FORCE_RIGHT_LEG_ARMOR" :checked="(anim_flags & 536870912) !== 0" @change="toggleFlag(536870912)"><label for="pck_anim_FORCE_RIGHT_LEG_ARMOR">Force Right Leg Armor</label></div><div><input type="checkbox" id="pck_anim_FORCE_LEFT_LEG_ARMOR" :checked="(anim_flags & 1073741824) !== 0" @change="toggleFlag(1073741824)"><label for="pck_anim_FORCE_LEFT_LEG_ARMOR">Force Left Leg Armor</label></div><div class="pck_anim_separator"></div><div class="pck_anim_group_label">Head</div><div><input type="checkbox" id="pck_anim_HEAD_BOBBING_DISABLED" :checked="(anim_flags & 512) !== 0" @change="toggleFlag(512)"><label for="pck_anim_HEAD_BOBBING_DISABLED">Head Bobbing Off</label></div><div><input type="checkbox" id="pck_anim_HEAD_DISABLED" :checked="(anim_flags & 1024) !== 0" @change="toggleFlag(1024)"><label for="pck_anim_HEAD_DISABLED">Head Disabled</label></div><div><input type="checkbox" id="pck_anim_HEAD_OVERLAY_DISABLED" :checked="(anim_flags & 65536) !== 0" @change="toggleFlag(65536)"><label for="pck_anim_HEAD_OVERLAY_DISABLED">Head Overlay Off</label></div><div><input type="checkbox" id="pck_anim_FORCE_HEAD_ARMOR" :checked="(anim_flags & 33554432) !== 0" @change="toggleFlag(33554432)"><label for="pck_anim_FORCE_HEAD_ARMOR">Force Head Armor</label></div><div class="pck_anim_separator"></div><div class="pck_anim_group_label">Body</div><div><input type="checkbox" id="pck_anim_BODY_DISABLED" :checked="(anim_flags & 8192) !== 0" @change="toggleFlag(8192)"><label for="pck_anim_BODY_DISABLED">Body Disabled</label></div><div><input type="checkbox" id="pck_anim_BODY_OVERLAY_DISABLED" :checked="(anim_flags & 16777216) !== 0" @change="toggleFlag(16777216)"><label for="pck_anim_BODY_OVERLAY_DISABLED">Body Overlay Off</label></div><div><input type="checkbox" id="pck_anim_FORCE_BODY_ARMOR" :checked="(anim_flags & 268435456) !== 0" @change="toggleFlag(268435456)"><label for="pck_anim_FORCE_BODY_ARMOR">Force Body Armor</label></div><div class="pck_anim_separator"></div><div class="pck_anim_group_label">Misc</div><div><input type="checkbox" id="pck_anim_ALL_ARMOR_DISABLED" :checked="(anim_flags & 256) !== 0" @change="toggleFlag(256)"><label for="pck_anim_ALL_ARMOR_DISABLED">All Armor Disabled</label></div><div><input type="checkbox" id="pck_anim_DO_BACKWARDS_CROUCH" :checked="(anim_flags & 131072) !== 0" @change="toggleFlag(131072)"><label for="pck_anim_DO_BACKWARDS_CROUCH">Backwards Crouch</label></div><div><input type="checkbox" id="pck_anim_RESOLUTION_64x64" :checked="(anim_flags & 262144) !== 0" @change="toggleFlag(262144)"><label for="pck_anim_RESOLUTION_64x64">64×64 Resolution</label></div><div><input type="checkbox" id="pck_anim_SLIM_MODEL" :checked="(anim_flags & 524288) !== 0" @change="toggleFlag(524288)"><label for="pck_anim_SLIM_MODEL">Slim Model</label></div><div><input type="checkbox" id="pck_anim_DINNERBONE" :checked="(anim_flags & 2147483648) !== 0" @change="toggleFlag(2147483648)"><label for="pck_anim_DINNERBONE">Dinnerbone</label></div></div></div>',
      },
    }),
  );

  track(
    new Panel({
      id: "pck_preview",
      name: "Armor Preview",
      icon: "preview",
      condition: { modes: ["animate"], formats: ["pck_skin"] },
      component: {
        name: "panel-pck_preview",
        data: () => ({ armor_pieces: armorPieces }),
        watch: {
          armor_pieces: {
            deep: true,
            handler(e, t) {
              rebuildArmorCubes();
            },
          },
        },
        methods: {
          onChestplateChange() {
            if (this.armor_pieces.chestplate) this.armor_pieces.elytra = false;
          },
          onCapeChange() {
            if (this.armor_pieces.cape) this.armor_pieces.elytra = false;
          },
          onElytraChange() {
            if (this.armor_pieces.elytra) {
              this.armor_pieces.chestplate = false;
              this.armor_pieces.cape = false;
            }
          },
        },
        template:
          '<div><div class="list pck_armor_list"><div class="list_inner_two_columns"><div><input type="checkbox" v-model="armor_pieces.helmet" id="pck_armor_helmet"><label for="pck_armor_helmet">Helmet</label></div><div><input type="checkbox" v-model="armor_pieces.chestplate" id="pck_armor_chestplate" @change="onChestplateChange"><label for="pck_armor_chestplate">Chestplate</label></div><div><input type="checkbox" v-model="armor_pieces.leggings" id="pck_armor_leggings"><label for="pck_armor_leggings">Leggings</label></div><div><input type="checkbox" v-model="armor_pieces.boots" id="pck_armor_boots"><label for="pck_armor_boots">Boots</label></div><div><input type="checkbox" v-model="armor_pieces.cape" id="pck_armor_cape" @change="onCapeChange"><label for="pck_armor_cape">Cape</label></div><div><input type="checkbox" v-model="armor_pieces.elytra" id="pck_armor_elytra" @change="onElytraChange"><label for="pck_armor_elytra">Elytra</label></div></div></div></div>',
      },
    }),
  );

  // ── PSM Import / Export ────────────────────────────────────────────────────
  //
  //  Coordinate note:
  //  PCK Studio / Minecraft store SkinBOX.Pos in bone-local space where Y
  //  increases DOWNWARD (Pos.Y=0 is the top of the bone). Blockbench is Y-up.
  //
  //  Import:  fromY = pivot.Y - psm.posY - psm.sizeY
  //  Export:  posY  = pivot.Y - cube.from.Y - cube.sizeY
  //
  //  X and Z are the same in both systems.

  const PARENT_BYTE_TO_NAME = ["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"];
  const PARENT_NAME_TO_BYTE = Object.fromEntries(PARENT_BYTE_TO_NAME.map((n, i) => [n, i]));

  // Per-bone data derived from GameConstants.cs
  // Translation: subtracted in PSM space (from TranslateToInternalPosition)
  // Pivot: bone origin in Blockbench world space = TransformSpace(pivot,(0,0,0),(1,1,0)) + (0,24,0)
  const BONE_TRANSLATION = {
    HEAD: [0, 0, 0],
    BODY: [0, 0, 0],
    ARM0: [-5, 2, 0],
    ARM1: [5, 2, 0],
    LEG0: [-2, 12, 0],
    LEG1: [2, 12, 0],
  };
  const BONE_BB_PIVOT = {
    HEAD: [0, 24, 0],
    BODY: [0, 24, 0],
    ARM0: [6, 22, 0],
    ARM1: [-6, 22, 0],
    LEG0: [2, 12, 0],
    LEG1: [-2, 12, 0],
  };

  const OFFSET_BYTE_TO_NAME = [
    "HEAD",
    "BODY",
    "ARM0",
    "ARM1",
    "LEG0",
    "LEG1",
    "TOOL0",
    "TOOL1",
    "HELMET",
    "SHOULDER0",
    "SHOULDER1",
    "CHEST",
    "WAIST",
    "PANTS0",
    "PANTS1",
    "BOOT0",
    "BOOT1",
  ];
  const OFFSET_NAME_TO_BYTE = Object.fromEntries(OFFSET_BYTE_TO_NAME.map((n, i) => [n, i]));

  const PSM_MAGIC = "psm";
  const PSM_VERSION = 1;

  function psmReadF32(view, off) {
    return view.getFloat32(off, true);
  }
  function psmReadI32(view, off) {
    return view.getInt32(off, true);
  }
  function psmWriteF32(view, off, v) {
    view.setFloat32(off, v, true);
  }
  function psmWriteI32(view, off, v) {
    view.setInt32(off, v, true);
  }

  function decodePSM(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    if (magic !== PSM_MAGIC) throw new Error(`Not a PSM file — expected header "psm", got "${magic}"`);
    const version = bytes[3];
    if (version !== 1) throw new Error(`Unsupported PSM version ${version} (only v1 is supported)`);

    let cur = 4;
    const animFlags = psmReadI32(view, cur);
    cur += 4;
    const partCount = psmReadI32(view, cur);
    cur += 4;
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      const parentName = PARENT_BYTE_TO_NAME[bytes[cur]];
      cur += 1;
      if (!parentName) throw new Error(`Unknown PSMParentType at part ${i}`);
      const posX = psmReadF32(view, cur);
      cur += 4;
      const posY = psmReadF32(view, cur);
      cur += 4;
      const posZ = psmReadF32(view, cur);
      cur += 4;
      const sizeX = psmReadF32(view, cur);
      cur += 4;
      const sizeY = psmReadF32(view, cur);
      cur += 4;
      const sizeZ = psmReadF32(view, cur);
      cur += 4;
      const mUvX = bytes[cur];
      cur += 1;
      const aUvY = bytes[cur];
      cur += 1;
      const inflate = psmReadF32(view, cur);
      cur += 4;
      parts.push({
        parentName,
        posX,
        posY,
        posZ,
        sizeX,
        sizeY,
        sizeZ,
        uvX: mUvX & 0x7f,
        uvY: aUvY & 0x7f,
        mirror: (mUvX & 0x80) !== 0,
        hideArmor: (aUvY & 0x80) !== 0,
        inflate,
      });
    }
    const offsetCount = psmReadI32(view, cur);
    cur += 4;
    const offsets = [];
    for (let i = 0; i < offsetCount; i++) {
      const typeName = OFFSET_BYTE_TO_NAME[bytes[cur]];
      cur += 1;
      if (!typeName) throw new Error(`Unknown PSMOffsetType at offset ${i}`);
      const value = psmReadF32(view, cur);
      cur += 4;
      offsets.push({ typeName, value });
    }
    return { version, animFlags, parts, offsets };
  }

  function encodePSM({ animFlags, parts, offsets }) {
    const total = 3 + 1 + 4 + 4 + parts.length * 31 + 4 + offsets.length * 5;
    const buffer = new ArrayBuffer(total);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    bytes[0] = PSM_MAGIC.charCodeAt(0);
    bytes[1] = PSM_MAGIC.charCodeAt(1);
    bytes[2] = PSM_MAGIC.charCodeAt(2);
    bytes[3] = PSM_VERSION;
    let cur = 4;
    psmWriteI32(view, cur, animFlags | 0);
    cur += 4;
    psmWriteI32(view, cur, parts.length);
    cur += 4;
    for (const p of parts) {
      const pb = PARENT_NAME_TO_BYTE[p.parentName];
      if (pb === undefined) throw new Error(`Unknown parent bone "${p.parentName}"`);
      bytes[cur] = pb;
      cur += 1;
      psmWriteF32(view, cur, p.posX);
      cur += 4;
      psmWriteF32(view, cur, p.posY);
      cur += 4;
      psmWriteF32(view, cur, p.posZ);
      cur += 4;
      psmWriteF32(view, cur, p.sizeX);
      cur += 4;
      psmWriteF32(view, cur, p.sizeY);
      cur += 4;
      psmWriteF32(view, cur, p.sizeZ);
      cur += 4;
      bytes[cur] = (p.mirror ? 0x80 : 0) | (Math.max(0, Math.min(64, Math.round(p.uvX))) & 0x7f);
      cur += 1;
      bytes[cur] = (p.hideArmor ? 0x80 : 0) | (Math.max(0, Math.min(64, Math.round(p.uvY))) & 0x7f);
      cur += 1;
      psmWriteF32(view, cur, p.inflate);
      cur += 4;
    }
    psmWriteI32(view, cur, offsets.length);
    cur += 4;
    for (const o of offsets) {
      const tb = OFFSET_NAME_TO_BYTE[o.typeName];
      if (tb === undefined) throw new Error(`Unknown offset type "${o.typeName}"`);
      bytes[cur] = tb;
      cur += 1;
      psmWriteF32(view, cur, o.value);
      cur += 4;
    }
    return buffer;
  }

  function modelToPSM() {
    const armorCubes = new Set(Project.pck_armor_cubes || []);
    const parts = [];
    for (const cube of Cube.all) {
      if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) continue;
      if (cube.uuid.startsWith(DRAW_MODE_UUID_PREFIX)) continue; // draw-mode template cubes — not exported
      if (armorCubes.has(cube)) continue;
      const parent = cube.parent;
      if (!(parent instanceof Group)) continue;
      // Resolve which root bone this cube belongs to.
      // Cubes may be directly under a root bone, or inside an offset folder nested under one.
      let boneName = parent.name;
      if (PARENT_NAME_TO_BYTE[boneName] === undefined) {
        // Parent is an offset folder — climb up to the root bone
        const grandparent = parent.parent;
        if (!(grandparent instanceof Group)) continue;
        boneName = grandparent.name;
        if (PARENT_NAME_TO_BYTE[boneName] === undefined) continue;
      }
      const sizeX = cube.to[0] - cube.from[0];
      const sizeY = cube.to[1] - cube.from[1];
      const sizeZ = cube.to[2] - cube.from[2];
      const t = BONE_TRANSLATION[boneName] || [0, 0, 0];
      // During import fromY had the bone's yOffset subtracted so the cube sits
      // at the correct world position relative to the shifted pivot.  On export
      // we must add it back so the PSM position is relative to the unshifted
      // default pivot — exactly what the game engine expects.
      const exportBone = Group.all.find((g) => g.name === boneName);
      const defaultBonePivotY = (BONE_BB_PIVOT[boneName] || [0, 0, 0])[1];
      const boneYOffset = exportBone ? defaultBonePivotY - exportBone.origin[1] : 0;
      parts.push({
        parentName: boneName,
        // TransformSpace(1,1,0) negates X+Y, leaves Z. _heightOffset=+24 on Y.
        // TranslateToInternalPosition (SkinModelImporter.cs):
        //   posX = -bbFrom.X - sizeX - translation.X
        //   posY = -bbFrom.Y - sizeY + 24 - translation.Y - boneYOffset
        //   posZ =  bbFrom.Z - translation.Z
        posX: -cube.from[0] - sizeX - t[0],
        posY: -cube.from[1] - sizeY + 24 - t[1] - boneYOffset,
        posZ: cube.from[2] - t[2],
        sizeX,
        sizeY,
        sizeZ,
        uvX: (cube.uv_offset || [0, 0])[0],
        uvY: (cube.uv_offset || [0, 0])[1],
        mirror: !!cube.mirror_uv,
        hideArmor: !!cube.psm_hide_with_armor,
        inflate: cube.inflate || 0,
      });
    }
    // Derive offsets from live bone pivots (root bones) and armor locator positions.
    //
    // Root bones (HEAD, BODY, ARM0, ARM1, LEG0, LEG1):
    //   value = BONE_BB_PIVOT[name].Y - bone.origin.Y
    //   (bone pivot drifts down when offset is positive)
    //
    // Armor locators (HELMET, CHEST, SHOULDER0/1, PANTS0/1, BOOT0/1):
    //   value = -(locator.position.Y - locator.defaultPos.Y)  →  value = -dy
    //   Moving the locator down by N → dy = -N → value = +N (armor drops by N)
    // WAIST: handled separately via the WAIST group pivot (see below).
    const offsets = [];
    const ROOT_BONE_NAMES = ["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"];

    ROOT_BONE_NAMES.forEach((boneName) => {
      const bone = Group.all.find((g) => g.name === boneName);
      if (!bone) return;
      const defaultY = (BONE_BB_PIVOT[boneName] || [0, 0, 0])[1];
      const value = defaultY - bone.origin[1];
      if (value !== 0) offsets.push({ typeName: boneName, value });
    });

    // Armor slot offsets come from the armor locators.
    // Only emit an offset entry when the locator has actually been moved.
    // WAIST is excluded — its offset is derived from the WAIST bone pivot below.
    const ARMOR_SLOT_LOCATOR_NAMES = [
      "HELMET",
      "CHEST",
      "SHOULDER0",
      "SHOULDER1",
      "PANTS0",
      "PANTS1",
      "BOOT0",
      "BOOT1",
    ];
    ARMOR_SLOT_LOCATOR_NAMES.forEach((locName) => {
      const [, dy] = getArmorLocatorOffset(locName);
      if (dy === 0) return; // unchanged — don't write a zero-value offset
      // Positive dy (locator moved up) → armor moves up → PSM value is negative.
      // Negative dy (locator moved down) → armor drops → PSM value is positive.
      const value = -dy;
      offsets.push({ typeName: locName, value });
    });

    // WAIST offset comes from the WAIST group pivot, same as before.
    // Import sets waistGroup.origin[1] = 12 + waistOffsetVal, so:
    //   value = origin[1] - 12
    const waistBone = Group.all.find((g) => g.name === "WAIST");
    if (waistBone) {
      const value = waistBone.origin[1] - 12;
      if (value !== 0) offsets.push({ typeName: "WAIST", value });
    }

    const animFlags = Project.psm_anim_flags != null ? Project.psm_anim_flags | 0 : 0;
    return { version: PSM_VERSION, animFlags, parts, offsets };
  }

  function psmToModel(psm) {
    // If no pck_skin project is open, create one automatically.
    if (Format.id !== "pck_skin") {
      if (!newProject(Formats.pck_skin)) return;
      Project.pck_skin_pack_uuid = guid();
      Project.texture_width = 64;
      Project.texture_height = 64;
    }

    suppressBoneGuard = true;
    Undo.initEdit({ elements: [], outliner: true });
    Project.psm_anim_flags = psm.animFlags;
    Project.psm_offsets = psm.offsets.map((o) => ({ typeName: o.typeName, value: o.value }));

    // Build offset lookup: all offset types -> Y value
    const offsetMap = {};
    psm.offsets.forEach((o) => {
      offsetMap[o.typeName] = o.value;
    });

    // WAIST: upper-body container for HEAD, BODY, ARM0, ARM1 only.
    // Pivot Y = 12 - (WAIST offset value if present in PSM).
    const WAIST_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1"]);
    const waistOffsetVal = offsetMap["WAIST"] || 0;
    let rootGroup = Group.all.find((g) => g.name === "ROOT" && !(g.parent instanceof Group));
    if (!rootGroup) {
      rootGroup = new Group({ name: "ROOT", origin: [0, 0, 0] }).init();
      rootGroup.export = false;
    }

    let waistGroup = Group.all.find((g) => g.name === "WAIST" && g.parent === rootGroup);
    if (!waistGroup) {
      waistGroup = new Group({ name: "WAIST", origin: [0, 12 + waistOffsetVal, 0] }).addTo(rootGroup).init();
      waistGroup.export = false;
    } else {
      // Update WAIST pivot to match the PSM offset.
      waistGroup.origin[1] = 12 + waistOffsetVal;
      waistGroup.updateElement();
    }

    // Build a map of existing root bones, creating any that are missing.
    // HEAD/BODY/ARM0/ARM1 nest under WAIST; LEG0/LEG1 stay at root.
    // Root bone pivot = BONE_BB_PIVOT shifted by the PSM offset on Y.
    const boneMap = {};
    Group.all.forEach((g) => {
      if (PARENT_NAME_TO_BYTE[g.name] !== undefined) boneMap[g.name] = g;
    });
    TEMPLATE_BONES.forEach((boneDef) => {
      const basePivot = BONE_BB_PIVOT[boneDef.name] || [0, 0, 0];
      const yOffset = offsetMap[boneDef.name] || 0;
      const targetOrigin = [basePivot[0], basePivot[1] - yOffset, basePivot[2]];
      if (boneMap[boneDef.name]) {
        // Bone already exists — update its pivot to match the PSM offsets.
        const g = boneMap[boneDef.name];
        g.origin[0] = targetOrigin[0];
        g.origin[1] = targetOrigin[1];
        g.origin[2] = targetOrigin[2];
        g.updateElement();
      } else {
        const g = new Group({
          name: boneDef.name,
          origin: targetOrigin,
        });
        if (WAIST_BONES.has(boneDef.name)) g.addTo(waistGroup);
        else if (boneDef.name === "LEG0" || boneDef.name === "LEG1") g.addTo(rootGroup);
        boneMap[boneDef.name] = g.init();
      }
    });

    // Apply armor slot offsets to the corresponding armor locators.
    // value = -dy  →  dy = -value  →  locator.position.Y = defaultPos.Y - value
    // Only touch locators that have an offset entry in the PSM.
    // WAIST is excluded — it is already handled via waistGroup.origin[1] above.
    const ARMOR_SLOT_NAMES = new Set([
      "HELMET",
      "CHEST",
      "SHOULDER0",
      "SHOULDER1",
      "PANTS0",
      "PANTS1",
      "BOOT0",
      "BOOT1",
    ]);
    // Track which locators were explicitly set via their own PSM offset entry,
    // so we know which ones to propagate from their parent bone instead.
    const explicitLocatorNames = new Set();
    psm.offsets.forEach((o) => {
      if (!ARMOR_SLOT_NAMES.has(o.typeName)) return;
      const locDef = ARMOR_LOCATORS.find((l) => l.name === o.typeName);
      if (!locDef) return;
      const loc = Locator.all.find((l) => l.name === o.typeName && isArmorLocator(l));
      if (!loc) return;
      // The offset value is relative to the parent bone's current pivot, not the
      // absolute default.  Account for the parent bone's own Y offset first.
      const parentBoneOffsetY = offsetMap[locDef.parentBone] || 0;
      loc.position[0] = locDef.defaultPos[0];
      loc.position[1] = locDef.defaultPos[1] - parentBoneOffsetY - o.value;
      loc.position[2] = locDef.defaultPos[2];
      loc.updateElement && loc.updateElement();
      explicitLocatorNames.add(o.typeName);
    });

    // Propagate root bone Y offsets into child armor locators that had no
    // explicit PSM offset of their own.  When a bone pivot shifts (e.g. HEAD Y 2
    // moves the pivot from 24 to 22), every locator parented to that bone must
    // shift by the same amount so armor preview stays correctly positioned.
    // Formula: locator.position.Y = defaultPos.Y - boneOffsetValue
    ARMOR_LOCATORS.forEach((locDef) => {
      if (explicitLocatorNames.has(locDef.name)) return; // already set above
      const boneOffset = offsetMap[locDef.parentBone] || 0;
      if (boneOffset === 0) return; // bone not offset — locator stays at default
      const loc = Locator.all.find((l) => l.name === locDef.name && isArmorLocator(l));
      if (!loc) return;
      loc.position[0] = locDef.defaultPos[0];
      loc.position[1] = locDef.defaultPos[1] - boneOffset;
      loc.position[2] = locDef.defaultPos[2];
      loc.updateElement && loc.updateElement();
    });

    // Remove previously-imported PSM cubes so re-importing is clean.
    Cube.all.filter((c) => c.psm_imported).forEach((c) => c.remove());

    for (const p of psm.parts) {
      const bone = boneMap[p.parentName];
      if (!bone) continue;
      // Inverse of TranslateToInternalPosition (SkinModelImporter.cs):
      //   psmPos = TransformSpace(bbFrom, size, (1,1,0)) + (0,24,0) - translation
      //   bbFrom.X = -psmPos.X - sizeX - translation.X
      //   bbFrom.Y = -psmPos.Y - sizeY + 24 - translation.Y
      //   bbFrom.Z =  psmPos.Z + translation.Z
      // The offset shifts both the bone pivot and the box positions equally,
      // so we also subtract it from Y to keep boxes at the correct world position.
      const t = BONE_TRANSLATION[p.parentName] || [0, 0, 0];
      const yOffset = offsetMap[p.parentName] || 0;
      const fromX = -p.posX - p.sizeX - t[0];
      const fromY = -p.posY - p.sizeY + 24 - t[1] - yOffset;
      const fromZ = p.posZ + t[2];
      const cube = new Cube({
        name: p.parentName,
        from: [fromX, fromY, fromZ],
        to: [fromX + p.sizeX, fromY + p.sizeY, fromZ + p.sizeZ],
        inflate: p.inflate,
        box_uv: true,
        uv_offset: [p.uvX, p.uvY],
        mirror_uv: p.mirror,
      });
      cube.psm_imported = true;
      cube.psm_hide_with_armor = p.hideArmor;
      cube.addTo(bone).init();
    }
    Undo.finishEdit("Import PSM");
    suppressBoneGuard = false;
    Canvas.updateAll();
    // Sync the ANIM flags panel to reflect the imported flags,
    // then show/hide template cubes to match.
    const animPanel = Interface.Panels.pck_anim;
    if (animPanel && animPanel.inside_vue) {
      animPanel.inside_vue.anim_flags = Project.psm_anim_flags || 0;
    }
    restoreTemplateCubes();
  }

  // ──────────────────────────────────────────────────────────────────────────

  // ── Bedrock Geometry Export ────────────────────────────────────────────────
  //
  // Exports the current model as a Bedrock-compatible geometry JSON using one
  // of three templates (Slim / 64×64 / 64×32) depending on the active ANIM flags.
  //
  // ANIM flag mapping:
  //   0x80000  = SLIM_MODEL       → use Slim template
  //   0x40000  = RESOLUTION_64x64 → use 64x64 template
  //   neither                     → use 64x32 template
  //
  // Overlay bones removed when their part's Disabled/OverlayOff flag is set:
  //   HEAD_DISABLED        (0x400)   → remove "hat"
  //   HEAD_OVERLAY_DISABLED(0x10000) → remove "hat"
  //   BODY_DISABLED        (0x2000)  → remove "jacket"
  //   BODY_OVERLAY_DISABLED(0x1000000)→ remove "jacket"
  //   RIGHT_ARM_DISABLED   (0x800)   → remove "rightSleeve"
  //   RIGHT_ARM_OVERLAY_DISABLED(0x200000) → remove "rightSleeve"
  //   LEFT_ARM_DISABLED    (0x1000)  → remove "leftSleeve"
  //   LEFT_ARM_OVERLAY_DISABLED(0x100000)  → remove "leftSleeve"
  //   RIGHT_LEG_DISABLED   (0x4000)  → remove "rightPants"
  //   RIGHT_LEG_OVERLAY_DISABLED(0x800000) → remove "rightPants"
  //   LEFT_LEG_DISABLED    (0x8000)  → remove "leftPants"
  //   LEFT_LEG_OVERLAY_DISABLED(0x400000)  → remove "leftPants"

  const BEDROCK_TEMPLATE_SLIM = {
    body: {
      parent: null,
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    head: {
      parent: "body",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    hat: {
      parent: "head",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5, mirror: false }],
      META_BoneType: "clothing",
    },
    helmet: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    helmetArmorOffset: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightArm: {
      parent: "body",
      pivot: [-5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-7, 12, -2], size: [3, 12, 4], uv: [40, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightSleeve: {
      parent: "rightArm",
      pivot: [-5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-7, 12, -2], size: [3, 12, 4], uv: [40, 32], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    rightArmArmor: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightArmArmorOffset: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightItem: { parent: "rightArm", pivot: [-6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    leftArm: {
      parent: "body",
      pivot: [5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [4, 12, -2], size: [3, 12, 4], uv: [32, 48], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    leftSleeve: {
      parent: "leftArm",
      pivot: [5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [4, 12, -2], size: [3, 12, 4], uv: [48, 48], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    leftArmArmor: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftArmArmorOffset: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    leftItem: { parent: "leftArm", pivot: [6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    jacket: {
      parent: "body",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], inflate: 0.25, uv: [16, 32], mirror: false }],
      META_BoneType: "clothing",
    },
    bodyArmor: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    bodyArmorOffset: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    waist: { parent: "body", pivot: [0, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightLeg: {
      parent: null,
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightPants: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 32], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    rightLegging: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightLeggingsArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    rightBoot: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightBootArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftLeg: {
      parent: null,
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [16, 48], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    leftPants: {
      parent: "leftLeg",
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [0, 48], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    leftLegging: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftLeggingsArmorOffset: {
      parent: "leftLeg",
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftBoot: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftBootArmorOffset: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
  };
  const BEDROCK_TEMPLATE_64x64 = {
    body: {
      parent: null,
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    head: {
      parent: "body",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    hat: {
      parent: "head",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5, mirror: false }],
      META_BoneType: "clothing",
    },
    helmet: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    helmetArmorOffset: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightArm: {
      parent: "body",
      pivot: [-5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightSleeve: {
      parent: "rightArm",
      pivot: [-5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 32], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    rightArmArmor: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightArmArmorOffset: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightItem: { parent: "rightArm", pivot: [-6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    leftArm: {
      parent: "body",
      pivot: [5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [32, 48], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    leftSleeve: {
      parent: "leftArm",
      pivot: [5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [48, 48], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    leftArmArmor: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftArmArmorOffset: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    leftItem: { parent: "leftArm", pivot: [6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    jacket: {
      parent: "body",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], inflate: 0.25, uv: [16, 32], mirror: false }],
      META_BoneType: "clothing",
    },
    bodyArmor: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    bodyArmorOffset: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    waist: { parent: "body", pivot: [0, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightLeg: {
      parent: null,
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightPants: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 32], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    rightLegging: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightLeggingsArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    rightBoot: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightBootArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftLeg: {
      parent: null,
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [16, 48], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    leftPants: {
      parent: "leftLeg",
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [0, 48], inflate: 0.25, mirror: false }],
      META_BoneType: "clothing",
    },
    leftLegging: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftLeggingsArmorOffset: {
      parent: "leftLeg",
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftBoot: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftBootArmorOffset: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
  };
  const BEDROCK_TEMPLATE_64x32 = {
    body: {
      parent: null,
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    head: {
      parent: "body",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    hat: {
      parent: "head",
      pivot: [0, 24, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5, mirror: false }],
      META_BoneType: "clothing",
    },
    helmet: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    helmetArmorOffset: { parent: "head", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightArm: {
      parent: "body",
      pivot: [-5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightSleeve: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "clothing" },
    rightArmArmor: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightArmArmorOffset: { parent: "rightArm", pivot: [-5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightItem: { parent: "rightArm", pivot: [-6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    leftArm: {
      parent: "body",
      pivot: [5, 22, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16], inflate: 0, mirror: true }],
      META_BoneType: "base",
    },
    leftSleeve: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "clothing" },
    leftArmArmor: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftArmArmorOffset: { parent: "leftArm", pivot: [5, 22, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    leftItem: { parent: "leftArm", pivot: [6, 15, 1], rotation: [0, 0, 0], META_BoneType: "item" },
    jacket: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "clothing" },
    bodyArmor: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    bodyArmorOffset: { parent: "body", pivot: [0, 24, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    waist: { parent: "body", pivot: [0, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
    rightLeg: {
      parent: null,
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, mirror: false }],
      META_BoneType: "base",
    },
    rightPants: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "clothing" },
    rightLegging: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightLeggingsArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    rightBoot: { parent: "rightLeg", pivot: [-1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    rightBootArmorOffset: {
      parent: "rightLeg",
      pivot: [-1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftLeg: {
      parent: null,
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [0, 16], inflate: 0, mirror: true }],
      META_BoneType: "base",
    },
    leftPants: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "clothing" },
    leftLegging: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftLeggingsArmorOffset: {
      parent: "leftLeg",
      pivot: [1.9, 12, 0],
      rotation: [0, 0, 0],
      META_BoneType: "armor_offset",
    },
    leftBoot: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor" },
    leftBootArmorOffset: { parent: "leftLeg", pivot: [1.9, 12, 0], rotation: [0, 0, 0], META_BoneType: "armor_offset" },
  };

  // Map from overlay bone name → the pair of ANIM flag bits (either set = remove the bone).
  const BEDROCK_OVERLAY_REMOVE_FLAGS = {
    hat: 0x10000, // HEAD_OVERLAY_DISABLED
    jacket: 0x1000000, // BODY_OVERLAY_DISABLED
    rightSleeve: 0x200000, // RIGHT_ARM_OVERLAY_DISABLED
    leftSleeve: 0x100000, // LEFT_ARM_OVERLAY_DISABLED
    rightPants: 0x800000, // RIGHT_LEG_OVERLAY_DISABLED
    leftPants: 0x400000, // LEFT_LEG_OVERLAY_DISABLED
  };

  // Force Armor flags (exact masks from ANIM panel):
  //   Force Head Armor       = 0x2000000
  //   Force Right Arm Armor  = 0x4000000
  //   Force Left Arm Armor   = 0x8000000
  //   Force Body Armor       = 0x10000000
  //   Force Right Leg Armor  = 0x20000000
  //   Force Left Leg Armor   = 0x40000000
  const BEDROCK_FORCE_ARMOR_EXACT = 0x2000000 | 0x4000000 | 0x8000000 | 0x10000000 | 0x20000000 | 0x40000000;

  function exportBedrockGeometry() {
    const flags = Project.psm_anim_flags || 0;
    const isSlim = (flags & 0x80000) !== 0;
    const is64x64 = (flags & 0x40000) !== 0;

    // Pick the right template (deep clone to avoid mutating the originals)
    const templateBones = isSlim ? BEDROCK_TEMPLATE_SLIM : is64x64 ? BEDROCK_TEMPLATE_64x64 : BEDROCK_TEMPLATE_64x32;

    const boneMap = JSON.parse(JSON.stringify(templateBones));

    // Remove overlay bones whose ANIM flags indicate they're disabled/off
    for (const [boneName, removeMask] of Object.entries(BEDROCK_OVERLAY_REMOVE_FLAGS)) {
      if ((flags & removeMask) !== 0) {
        delete boneMap[boneName];
      }
    }

    // ── Collect armor-masked BOX cubes from the model ────────────────────────
    //
    // Any cube with pck_armor_mask !== 0 is a skin cube that should be hidden
    // when a specific armor piece is worn. In the Bedrock geometry these cubes
    // live inside the corresponding armor sub-bone rather than the base bone.
    //
    // Armor mask bits (from SkinBOX.cs / pck_importer):
    //   1 = HELMET      → target bone: "helmet"
    //   2 = CHESTPLATE  → target bone depends on parent:
    //                      HEAD  → "helmet"  (treated as helmet for body-covering head pieces)
    //                      BODY  → "bodyArmor"
    //                      ARM0  → "rightArmArmor"
    //                      ARM1  → "leftArmArmor"
    //   4 = LEGGINGS    → target bone depends on parent:
    //                      LEG0  → "rightLegging"
    //                      LEG1  → "leftLegging"
    //   8 = BOOTS       → target bone depends on parent:
    //                      LEG0  → "rightBoot"
    //                      LEG1  → "leftBoot"
    //
    // A cube may have multiple bits set — it is cloned into every matching
    // armor bone. Cubes with no mask bits are exported normally in their base bone.
    //
    // Coordinate transform: Blockbench "from/to" → Bedrock "origin/size"
    //   origin = from
    //   size   = to - from

    // Maps from PCK bone names to Bedrock base bone names (plain cubes).
    const PCK_BONE_TO_BEDROCK_BASE = {
      HEAD: "head",
      BODY: "body",
      ARM0: "rightArm",
      ARM1: "leftArm",
      LEG0: "rightLeg",
      LEG1: "leftLeg",
    };

    // Per-parent-bone lookup for each armor bit
    const ARMOR_BIT_BONE = {
      1: { HEAD: "helmet", BODY: "helmet", ARM0: "helmet", ARM1: "helmet", LEG0: "helmet", LEG1: "helmet" },
      2: {
        HEAD: "helmet",
        BODY: "bodyArmor",
        ARM0: "rightArmArmor",
        ARM1: "leftArmArmor",
        LEG0: "bodyArmor",
        LEG1: "bodyArmor",
      },
      4: {
        LEG0: "rightLegging",
        LEG1: "leftLegging",
        HEAD: "rightLegging",
        BODY: "rightLegging",
        ARM0: "rightLegging",
        ARM1: "leftLegging",
      },
      8: {
        LEG0: "rightBoot",
        LEG1: "leftBoot",
        HEAD: "rightBoot",
        BODY: "rightBoot",
        ARM0: "rightBoot",
        ARM1: "leftBoot",
      },
    };

    // Build a live locator position lookup from the open project.
    // Hoisted early so it is available during the cube-collection loop below
    // (armor-masked cubes need to check whether their target sub-bone's locator exists).
    const locatorPositions = {};
    for (const loc of Locator.all) {
      if (isArmorLocator(loc)) {
        locatorPositions[loc.name] = loc.position.slice();
      }
    }

    // Every armor/armor_offset bone is gated on its driving locator existing.
    // If the locator was never created (no offset for it or its parent bone),
    // the bone carries no useful data and must be omitted from the output.
    // Hoisted early so the cube-collection loop can use it for fallback routing.
    const LOCATOR_GATED_BONES = {
      helmet: "HELMET",
      helmetArmorOffset: "HELMET",
      bodyArmor: "CHEST",
      bodyArmorOffset: "CHEST",
      rightArmArmor: "SHOULDER0",
      rightArmArmorOffset: "SHOULDER0",
      leftArmArmor: "SHOULDER1",
      leftArmArmorOffset: "SHOULDER1",
      rightLegging: "PANTS0",
      rightLeggingsArmorOffset: "PANTS0",
      leftLegging: "PANTS1",
      leftLeggingsArmorOffset: "PANTS1",
      rightBoot: "BOOT0",
      rightBootArmorOffset: "BOOT0",
      leftBoot: "BOOT1",
      leftBootArmorOffset: "BOOT1",
    };

    // Hoisted here so it is available during the cube-collection loop below.
    const BEDROCK_BONE_TO_PCK_BONE = {
      head: "HEAD",
      helmet: "HEAD",
      helmetArmorOffset: "HEAD",
      body: "BODY",
      jacket: "BODY",
      bodyArmor: "BODY",
      bodyArmorOffset: "BODY",
      rightArm: "ARM0",
      rightArmArmor: "ARM0",
      rightArmArmorOffset: "ARM0",
      rightItem: "ARM0",
      leftArm: "ARM1",
      leftArmArmor: "ARM1",
      leftArmArmorOffset: "ARM1",
      leftItem: "ARM1",
      rightLeg: "LEG0",
      rightLegging: "LEG0",
      rightLeggingsArmorOffset: "LEG0",
      rightBoot: "LEG0",
      rightBootArmorOffset: "LEG0",
      leftLeg: "LEG1",
      leftLegging: "LEG1",
      leftLeggingsArmorOffset: "LEG1",
      leftBoot: "LEG1",
      leftBootArmorOffset: "LEG1",
    };

    // Build a live lookup of root PCK bone group origins.
    // Hoisted here so it is available during the cube-collection loop below
    // (the cube Y correction needs the live pivot Y to undo the pck_importer shift).
    const liveBonePivot = {};
    const PCK_BONE_NAMES = ["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"];
    for (const pckName of PCK_BONE_NAMES) {
      const g = Group.all.find((gr) => gr.name === pckName);
      if (g) liveBonePivot[pckName] = g.origin.slice();
    }

    // Map: bone name → extra cubes to inject (beyond the template defaults)
    const armorBoneCubes = {}; // armor-masked cubes → armor sub-bones
    const baseBoneCubes = {}; // plain cubes        → base bones

    const armorCubeSet = new Set(Project.pck_armor_cubes || []);

    // Arm/leg Bedrock bone names whose cube X origins must be mirrored
    // (PCK stores them on the opposite X side to Bedrock convention).
    const MIRROR_LIMB_BONES = new Set(["rightArm", "leftArm", "rightLeg", "leftLeg"]);
    // Armor sub-bones that are children of an arm/leg limb bone — their cubes
    // also need X mirroring because they inherit the same PCK-side convention.
    const MIRROR_LIMB_ARMOR_BONES = new Set([
      "rightArmArmor",
      "leftArmArmor",
      "rightLegging",
      "leftLegging",
      "rightBoot",
      "leftBoot",
    ]);

    for (const cube of Cube.all) {
      // Skip internal/non-exported cubes
      if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) continue;
      if (cube.uuid.startsWith("dddddddd")) continue; // draw-mode cubes
      if (armorCubeSet.has(cube)) continue; // armor preview cubes

      // Resolve the PCK root bone name for this cube
      const parent = cube.parent;
      if (!(parent instanceof Group)) continue;
      let boneName = parent.name;
      if (PARENT_NAME_TO_BYTE[boneName] === undefined) {
        const grandparent = parent.parent;
        if (!(grandparent instanceof Group)) continue;
        boneName = grandparent.name;
        if (PARENT_NAME_TO_BYTE[boneName] === undefined) continue;
      }

      // Build the Bedrock cube entry: origin = from, size = to - from
      const sizeX = Math.round((cube.to[0] - cube.from[0]) * 1000) / 1000;
      const sizeY = Math.round((cube.to[1] - cube.from[1]) * 1000) / 1000;
      const sizeZ = Math.round((cube.to[2] - cube.from[2]) * 1000) / 1000;

      // pck_importer shifts cube.from[1] by -yOffset when importing PCK BOX data,
      // so that cubes stay at the correct world position relative to the shifted bone pivot.
      // However this over-shifts when the offset is negative (bone moved up), placing
      // the cube 1+ units too high in Bedrock world space.  Undo that shift here:
      //   correction = defaultBonePivotY - liveBonePivotY
      // e.g. ARM1 default Y=22, live Y=23 → correction = -1 → origin Y reduced by 1.
      const _pckBoneForCube = BEDROCK_BONE_TO_PCK_BONE[PCK_BONE_TO_BEDROCK_BASE[boneName]] || boneName;
      const _defaultPivotY = (BONE_BB_PIVOT[boneName] || [0, 0, 0])[1];
      const _livePivotY = liveBonePivot[boneName] ? liveBonePivot[boneName][1] : _defaultPivotY;
      const _cubeYCorrection = _defaultPivotY - _livePivotY;

      const bedrockCube = {
        origin: [
          Math.round(cube.from[0] * 1000) / 1000,
          Math.round((cube.from[1] + _cubeYCorrection) * 1000) / 1000,
          Math.round(cube.from[2] * 1000) / 1000,
        ],
        size: [sizeX, sizeY, sizeZ],
        uv: [cube.uv_offset[0], cube.uv_offset[1]],
        inflate: cube.inflate || 0,
        mirror: !!cube.mirror_uv,
      };

      if (!cube.pck_armor_mask) {
        // Plain cube: append to its base bone
        const targetBone = PCK_BONE_TO_BEDROCK_BASE[boneName];
        if (!targetBone) continue;
        // Mirror cube origin X for arm/leg bones: PCK stores these on the opposite
        // X side to Bedrock convention.  new_origin_X = -(origin_X + size_X)
        const cubeToPush = MIRROR_LIMB_BONES.has(targetBone)
          ? Object.assign({}, bedrockCube, {
              origin: [-(bedrockCube.origin[0] + bedrockCube.size[0]), bedrockCube.origin[1], bedrockCube.origin[2]],
            })
          : bedrockCube;
        if (!baseBoneCubes[targetBone]) baseBoneCubes[targetBone] = [];
        baseBoneCubes[targetBone].push(cubeToPush);
      } else {
        // Armor-masked cube: route into every matching armor sub-bone.
        // If the target armor sub-bone has no driving locator (it will be filtered out
        // of the final output), fall back to placing the cube in the base Bedrock bone
        // instead — this preserves the geometry rather than silently discarding it.
        let routedToArmorBone = false;
        for (const [bit, boneByParent] of Object.entries(ARMOR_BIT_BONE)) {
          if ((cube.pck_armor_mask & Number(bit)) === 0) continue;
          const targetBone = boneByParent[boneName];
          if (!targetBone) continue;

          // Check whether this armor sub-bone is locator-gated and the locator exists.
          const gateLocator = LOCATOR_GATED_BONES[targetBone];
          const locatorPresent = !gateLocator || !!locatorPositions[gateLocator];

          if (locatorPresent) {
            // Normal path: place in the armor sub-bone.
            if (!armorBoneCubes[targetBone]) armorBoneCubes[targetBone] = [];
            const alreadyAdded = armorBoneCubes[targetBone].some(
              (c) =>
                c.origin[0] === bedrockCube.origin[0] &&
                c.origin[1] === bedrockCube.origin[1] &&
                c.origin[2] === bedrockCube.origin[2] &&
                c.size[0] === bedrockCube.size[0] &&
                c.uv[0] === bedrockCube.uv[0] &&
                c.uv[1] === bedrockCube.uv[1],
            );
            if (!alreadyAdded) {
              // Mirror X for armor cubes landing on arm/leg armor sub-bones.
              const armorCubeToPush = MIRROR_LIMB_ARMOR_BONES.has(targetBone)
                ? Object.assign({}, bedrockCube, {
                    origin: [
                      -(bedrockCube.origin[0] + bedrockCube.size[0]),
                      bedrockCube.origin[1],
                      bedrockCube.origin[2],
                    ],
                  })
                : bedrockCube;
              armorBoneCubes[targetBone].push(armorCubeToPush);
              routedToArmorBone = true;
            } else {
              routedToArmorBone = true; // already present, still counts as routed
            }
          }
        }

        // Fallback: if every target armor sub-bone was locator-gated and no locator
        // existed, the cube has nowhere to go.  Place it in the plain base bone so
        // the geometry is not lost from the export.
        if (!routedToArmorBone) {
          const targetBone = PCK_BONE_TO_BEDROCK_BASE[boneName];
          if (targetBone) {
            const cubeToPush = MIRROR_LIMB_BONES.has(targetBone)
              ? Object.assign({}, bedrockCube, {
                  origin: [
                    -(bedrockCube.origin[0] + bedrockCube.size[0]),
                    bedrockCube.origin[1],
                    bedrockCube.origin[2],
                  ],
                })
              : bedrockCube;
            if (!baseBoneCubes[targetBone]) baseBoneCubes[targetBone] = [];
            // Avoid duplicates
            const alreadyInBase = baseBoneCubes[targetBone].some(
              (c) =>
                c.origin[0] === cubeToPush.origin[0] &&
                c.origin[1] === cubeToPush.origin[1] &&
                c.origin[2] === cubeToPush.origin[2] &&
                c.size[0] === cubeToPush.size[0] &&
                c.uv[0] === cubeToPush.uv[0] &&
                c.uv[1] === cubeToPush.uv[1],
            );
            if (!alreadyInBase) baseBoneCubes[targetBone].push(cubeToPush);
          }
        }
      }
    }

    // NOTE: liveBonePivot is defined earlier in this function
    // (hoisted above the cube-collection loop) so it is available there.

    // Map each Bedrock bone to the PCK root bone whose live pivot it should inherit.
    // Armor-offset bones are excluded here — they use locator positions instead (below).
    // NOTE: BEDROCK_BONE_TO_PCK_BONE is defined earlier in this function
    // (hoisted above the cube-collection loop) so it is available there.

    // Map from Bedrock armor-offset bone name to the PCK armor locator name that
    // drives its pivot. The locator world-space position becomes the bone pivot.
    // Only waist has a special pivot source (the live WAIST group origin).
    // All *ArmorOffset bones share the same pivot as their paired main bone,
    // sourced from the live PCK root bone group origin via BEDROCK_BONE_TO_PCK_BONE.
    const ARMOR_OFFSET_BONE_TO_LOCATOR = {
      waist: null, // driven by WAIST group pivot
    };

    // WAIST pivot comes from the WAIST group origin, not a locator.
    const waistBoneGroup = Group.all.find((g) => g.name === "WAIST");
    const waistPivot = waistBoneGroup ? waistBoneGroup.origin.slice() : [0, 12, 0];

    // NOTE: locatorPositions and LOCATOR_GATED_BONES are defined earlier in this
    // function (hoisted above the cube-collection loop) so they are available there.

    // Build the bones array, injecting both plain and armor-masked cubes,
    // patching ALL bone pivots from live group origins and locator positions.
    const bonesArray = Object.keys(templateBones)
      .filter((name) => boneMap[name] !== undefined)
      .filter((name) => {
        // Omit armor bones whose driving locator was never created
        const gateLocator = LOCATOR_GATED_BONES[name];
        if (gateLocator && !locatorPositions[gateLocator]) return false;
        return true;
      })
      .map((name) => {
        const bone = boneMap[name];

        // Determine pivot from the most specific live source available:
        //   1. Armor-offset bones: use the live locator position (or waist group origin).
        //   2. All other bones: use the live PCK root bone's group.origin so that
        //      any Y offset applied during import is reflected correctly.
        //   3. Fallback: template default (no offset, standard skin).
        let pivot = bone.pivot;

        if (Object.prototype.hasOwnProperty.call(ARMOR_OFFSET_BONE_TO_LOCATOR, name)) {
          // Armor-offset bone
          const locName = ARMOR_OFFSET_BONE_TO_LOCATOR[name];
          if (locName === null) {
            // waist: use live WAIST group origin
            pivot = waistPivot.slice();
          } else if (locatorPositions[locName]) {
            pivot = locatorPositions[locName].slice();
          }
        } else {
          // Non-offset bone: derive pivot from the live PCK root bone origin,
          // using the template as a baseline and applying only the delta from the
          // PCK bone's offset relative to its default position.
          const pckBone = BEDROCK_BONE_TO_PCK_BONE[name];
          if (pckBone && liveBonePivot[pckBone]) {
            pivot = liveBonePivot[pckBone].slice();

            // ── Pivot X for arm/leg and their child bones ────────────────────
            // PCK stores arm/leg pivots on the opposite X side to Bedrock convention.
            // The correct Bedrock pivot X is derived from the template default plus the
            // X delta of the live PCK bone relative to its default pivot:
            //   bedrockPivotX = templatePivotX - (livePCKpivotX - defaultPCKpivotX)
            //
            // This correctly handles:
            //   • Standard (no offset): delta=0, pivot X = template default  e.g. rightArm → -5
            //   • X-shifted bone: delta propagates the shift in the mirrored direction
            //
            // Armor sub-bones with a locator (rightArmArmor etc.) use the locator X negated
            // instead, because their pivot comes from the armor attachment point, not the
            // bone pivot. Items and ArmorOffset bones use the template-delta formula.
            const LIMB_SIDE = {
              rightArm: "right",
              leftArm: "left",
              rightArmArmor: "right",
              leftArmArmor: "left",
              rightArmArmorOffset: "right",
              leftArmArmorOffset: "left",
              rightItem: "right",
              leftItem: "left",
              rightLeg: "rightLeg",
              leftLeg: "leftLeg",
              rightLegging: "rightLeg",
              leftLegging: "leftLeg",
              rightLeggingsArmorOffset: "rightLeg",
              leftLeggingsArmorOffset: "leftLeg",
              rightBoot: "rightLeg",
              leftBoot: "leftLeg",
              rightBootArmorOffset: "rightLeg",
              leftBootArmorOffset: "leftLeg",
            };

            // Map: armor sub-bone → locator name whose X drives the pivot (negated).
            // These are bones that represent the armor attachment joint, not the limb joint.
            const ARMOR_SUBONE_LOCATOR_X = {
              rightArmArmor: "SHOULDER0",
              rightArmArmorOffset: "SHOULDER0",
              leftArmArmor: "SHOULDER1",
              leftArmArmorOffset: "SHOULDER1",
              rightLegging: "PANTS0",
              rightLeggingsArmorOffset: "PANTS0",
              leftLegging: "PANTS1",
              leftLeggingsArmorOffset: "PANTS1",
              rightBoot: "BOOT0",
              rightBootArmorOffset: "BOOT0",
              leftBoot: "BOOT1",
              leftBootArmorOffset: "BOOT1",
            };

            const side = LIMB_SIDE[name];
            if (side !== undefined) {
              const armorLocName = ARMOR_SUBONE_LOCATOR_X[name];
              if (armorLocName && locatorPositions[armorLocName]) {
                // Armor sub-bone: pivot X = negated locator X (mirrors PCK → Bedrock convention).
                pivot[0] = -locatorPositions[armorLocName][0];
              } else {
                // Limb base bone, item bone, or armor sub-bone without a locator:
                // pivot X = templatePivotX - (livePCKpivotX - defaultPCKpivotX)
                const defaultPCKX = (BONE_BB_PIVOT[pckBone] || [0])[0];
                const livePCKX = liveBonePivot[pckBone][0];
                const templateX = bone.pivot ? bone.pivot[0] : 0;
                pivot[0] = templateX - (livePCKX - defaultPCKX);
              }
            }

            // ── head pivot: always use template default [0, 24, 0] ───────────
            // HEAD group.origin shifts when a HEAD Y-offset is applied (to move
            // the head geometry), but the Bedrock head bone pivot is the neck joint
            // and must stay at Y=24 regardless. Only body/arm/leg pivots change with offsets.
            if (name === "head") {
              pivot = (bone.pivot || [0, 24, 0]).slice();
            }
          }
        }

        const entry = { name, parent: bone.parent, pivot, rotation: bone.rotation };

        // When a base part's _DISABLED flag is set AND the skin has custom BOX cubes
        // for that bone, the template skeleton cube is redundant and should be omitted —
        // the custom geometry fully replaces it.  If no custom cubes exist for that bone
        // the template cube must stay so the bone isn't rendered as empty geometry.
        //
        // Disable mask per Bedrock base bone:
        //   head:     HEAD_DISABLED       (0x400)
        //   body:     BODY_DISABLED       (0x2000)
        //   rightArm: RIGHT_ARM_DISABLED  (0x800)
        //   leftArm:  LEFT_ARM_DISABLED   (0x1000)
        //   rightLeg: RIGHT_LEG_DISABLED  (0x4000)
        //   leftLeg:  LEFT_LEG_DISABLED   (0x8000)
        const BASE_BONE_DISABLE_FLAG = {
          head: 0x400,
          body: 0x2000,
          rightArm: 0x800,
          leftArm: 0x1000,
          rightLeg: 0x4000,
          leftLeg: 0x8000,
        };
        const plainCubes = baseBoneCubes[name] || [];
        const disableFlag = BASE_BONE_DISABLE_FLAG[name];
        const partIsDisabled = disableFlag !== undefined && (flags & disableFlag) !== 0;
        // When a part is disabled, never include the template skeleton cube — the skin
        // either provides its own replacement cubes or intentionally leaves the bone empty.
        const templateCubes = !partIsDisabled && bone.cubes && bone.cubes.length > 0 ? [...bone.cubes] : [];
        // Armor-masked BOX cubes go into their armor sub-bones
        const injected = armorBoneCubes[name] || [];
        const allCubes = [...templateCubes, ...plainCubes, ...injected];
        if (allCubes.length > 0) entry.cubes = allCubes;
        entry.META_BoneType = bone.META_BoneType;
        return entry;
      });

    // Map ANIM flags to animation properties
    // Static Arms (0x1), Statue of Liberty (0x80), Synced Arms (0x40),
    // Static Legs (0x4), Synced Legs (0x20), Head Bobbing Off (0x200),
    // Backwards Crouch (0x20000), All Armor Disabled (0x100), Dinnerbone (0x80000000)
    // Bad Santa (0x8) is intentionally excluded per spec.
    const animArmsDown = (flags & 0x1) !== 0; // Static Arms
    const animArmsOutFront = (flags & 0x80) !== 0; // Statue of Liberty
    const animInvertedCrouch = (flags & 0x20000) !== 0; // Backwards Crouch
    const animNoHeadBob = (flags & 0x200) !== 0; // Head Bobbing Off
    const animSingleArmAnimation = (flags & 0x40) !== 0; // Synced Arms
    const animSingleLegAnimation = (flags & 0x20) !== 0; // Synced Legs
    const animStationaryLegs = (flags & 0x4) !== 0; // Static Legs
    const animStatueOfLiberty = (flags & 0x80) !== 0; // Statue of Liberty (ArmsOutFront alias)
    const animUpsideDown = (flags & 0x80000000) !== 0; // Dinnerbone
    // All Armor Disabled only sets animationDontShowArmor if no Force Armor flag overrides it
    const allArmorOff = (flags & 0x100) !== 0;
    const anyForceArmor = (flags & BEDROCK_FORCE_ARMOR_EXACT) !== 0;
    const animDontShowArmor = allArmorOff && !anyForceArmor;

    const skinName = (Project.name || "skin").replace(/\s+/g, "_");
    const hasCape = Texture.all.some((t) => t.name && t.name.toLowerCase().includes("cape"));
    const capeValue = hasCape ? `${skinName}_cape.png` : null;

    const geoKey = `geometry.Skins.PCK.${skinName}`;
    const textureHeight = isSlim || is64x64 ? 64 : 32;

    const output = {
      [geoKey]: {
        bones: bonesArray,
        texturewidth: 64,
        textureheight: textureHeight,
        META_ModelVersion: "1.0.6",
        rigtype: isSlim ? "slim" : "normal",
        cape: capeValue,
        animationArmsDown: animArmsDown,
        animationArmsOutFront: animArmsOutFront,
        animationDontShowArmor: animDontShowArmor,
        animationInvertedCrouch: animInvertedCrouch,
        animationNoHeadBob: animNoHeadBob,
        animationSingleArmAnimation: animSingleArmAnimation,
        animationSingleLegAnimation: animSingleLegAnimation,
        animationStationaryLegs: animStationaryLegs,
        animationStatueOfLibertyArms: animStatueOfLiberty,
        animationUpsideDown: animUpsideDown,
      },
    };

    Blockbench.export({
      type: "Bedrock Geometry JSON",
      extensions: ["json"],
      name: skinName,
      content: JSON.stringify(output, null, 2),
    });
  }

  Plugin.register("pck_skin_helper", {
    title: "PCK Skin Helper",
    author: "BehaviorPack",
    icon: "icon-player",
    description: "Create Minecraft Legacy Console skins and export them for PCK Studio",
    about:
      'To get started, click "<b>PCK Skin</b>"<br>└─ You can delete <b>cape.png</b> or replace it with your own.<br>└─ Use <b>"Toggle Drawbal Ghost"</b> to allow drawing on the base model.<br>└─ "<b>Preview</b>" to display Armor placement and Animations.<br>└─ "<b>ANIM FLAGS</b>" is for controlling parts of your Skin ingame.<br>You can click "<b>Import PSM..</b>" to import a Skin from PCK Studio.<br>You can also "<b>Export PSM..</b>" to transfer it back to PCK Studio.<br>Use "<b>Validate PCK Skin</b>" to make sure your Skin will import correctly.<br>A option to "<b>Unlock Root Bones</b>" exist but is not recommended.<img src="data:image/png;base64,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"><br><p class="note"><i>Note that your Skin Texture can <b>not</b> be greater than 32kb and your UV can <b>only</b> be 64x64 or 64x32.</i></p>',
    version: "1.0.5",
    min_version: "4.0.0",
    creation_date: "2026-03-11",
    variant: "both",
    await_loading: true,

    onload() {
      this.actionNew = new Action("new_pck_skin", {
        name: "PCK Skin Model (.PSM)",
        description: "Creates a template PCK Skin",
        icon: "icon-player",
        click() {
          Formats.pck_skin.new();
        },
      });
      this.actionValidate = new Action("export_pck_skin", {
        name: "Validate PCK Skin",
        description: "Validates the PCK Skin and generates an Skin Sheet",
        icon: "verified_user",
        condition: { formats: ["pck_skin"] },
        click() {
          validateAndSaveSkinSheet();
        },
      });
      MenuBar.addAction(this.actionValidate, "file.export");

      this.actionImportPSM = new Action("import_psm", {
        name: "Import PSM",
        description: "Import custom skin as a PCK Studio file (.PSM)",
        icon: "download",
        condition: { formats: ["pck_skin"] },
        click() {
          Blockbench.import({ type: "PSM File", extensions: ["psm"], multiple: false, readtype: "binary" }, (files) => {
            const file = files[0];
            if (!file) return;
            let psm;
            try {
              psm = decodePSM(file.content);
            } catch (err) {
              Blockbench.showMessageBox({
                title: "PSM Import Error",
                message: `Failed to read PSM: ${err.message}`,
                buttons: ["OK"],
              });
              return;
            }
            psmToModel(psm);
            Blockbench.showQuickMessage(
              `Imported ${psm.parts.length} box${psm.parts.length !== 1 ? "es" : ""} from PSM`,
              2200,
            );
          });
        },
      });

      this.actionExportPSM = new Action("export_psm", {
        name: "Export PSM",
        description: "Export custom skin as a PCK Studio file (.PSM)",
        icon: "upload",
        condition: { formats: ["pck_skin"] },
        click() {
          if (!validateSkeleton()) return;
          let buffer;
          try {
            buffer = encodePSM(modelToPSM());
          } catch (err) {
            Blockbench.showMessageBox({
              title: "PSM Export Error",
              message: `Failed to encode PSM: ${err.message}`,
              buttons: ["OK"],
            });
            return;
          }
          // custom_writer bypasses Blockbench's built-in UTF-8 string writer.
          // Blockbench shows the native Save dialog, then calls custom_writer(content, path).
          // We ignore content and write the raw ArrayBuffer as a binary Buffer instead.
          Blockbench.export({
            type: "PSM File",
            extensions: ["psm"],
            name: (Project.name || "skin").replace(/\s+/g, "_"),
            content: "",
            custom_writer(content, path) {
              fs.writeFileSync(path, Buffer.from(buffer));
            },
          });
        },
      });

      this.actionToggleLock = new Action("pck_toggle_bone_lock", {
        name: "Unlock Root Bones",
        description: "Toggle locking of root skeleton bones (HEAD, BODY, ARM0/1, LEG0/1, WAIST, ROOT)",
        icon: "lock_open",
        condition: { formats: ["pck_skin"] },
        click() {
          boneLockEnabled = !boneLockEnabled;
          this.name = boneLockEnabled ? "Unlock Root Bones" : "Lock Root Bones";
          this.icon = boneLockEnabled ? "lock_open" : "lock";
          Blockbench.showQuickMessage(
            boneLockEnabled ? "Root bones are now locked." : "Root bones are now unlocked — be careful!",
            2000,
          );
        },
      });

      this.actionDrawMode = new Action("pck_toggle_draw_mode", {
        name: "Toggle Drawable Ghost",
        description: "Places drawable template cubes and hides the ghost — press again to remove them",
        icon: "edit_off",
        condition: { formats: ["pck_skin"] },
        click() {
          setDrawMode(!drawModeEnabled);
        },
      });

      this.actionExportBedrock = new Action("export_bedrock_geometry", {
        name: "Export Bedrock Geometry",
        description: "Export skin as a Bedrock-compatible geometry JSON for use with PCK Studio",
        icon: "language",
        condition: { formats: ["pck_skin"] },
        click() {
          exportBedrockGeometry();
        },
      });
      MenuBar.addAction(this.actionExportBedrock, "file.export");

      MenuBar.addAction(this.actionImportPSM, "file.import");
      MenuBar.addAction(this.actionExportPSM, "file.export");
      MenuBar.addAction(this.actionToggleLock, "file");
      MenuBar.addAction(this.actionDrawMode, "file");
    },

    onunload() {
      this.actionNew.delete();
      this.actionValidate.delete();
      this.actionImportPSM.delete();
      this.actionExportPSM.delete();
      this.actionExportBedrock.delete();
      this.actionToggleLock.delete();
      this.actionDrawMode.delete();
      if (drawModeEnabled) {
        drawModeEnabled = false;
        clearDrawModeCubes();
      }
      registered.forEach((item) => {
        if (typeof item.delete === "function") item.delete();
        else if (typeof item.remove === "function") item.remove();
      });
      registered.splice(0, Infinity);
    },
  });
})();
