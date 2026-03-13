(function () {
  "use strict";

  const registered = [];
  function track(item) {
    registered.push(item);
    return item;
  }

  const LOCKED_BONES = new Set(["HEAD", "BODY", "ARM0", "ARM1", "LEG0", "LEG1"]);

  const TEMPLATE_BONES = [
    {
      name: "HEAD",
      pivot: [0, 24, 0],
      cubes: [
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0], inflate: 0 },
        { origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.25 },
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

  function buildTemplateSkeleton() {
    TEMPLATE_BONES.forEach((boneDef) => {
      const group = new Group({
        name: boneDef.name,
        origin: boneDef.pivot,
      }).init();

      boneDef.cubes.forEach((cubeDef, i) => {
        const from = cubeDef.origin.slice();
        const to = [
          cubeDef.origin[0] + cubeDef.size[0],
          cubeDef.origin[1] + cubeDef.size[1],
          cubeDef.origin[2] + cubeDef.size[2],
        ];

        new Cube({
          name: boneDef.name,
          from,
          to,
          inflate: cubeDef.inflate,
          box_uv: true,
          uv_offset: cubeDef.uv,
        })
          .addTo(group)
          .init();
      });
    });
  }

  function onNameChanged({ object, new_name, old_name }) {
    if (Format.id !== "pck_skin") return;
    if (!(object instanceof Group)) return;
    if (!LOCKED_BONES.has(old_name)) return;

    object.name = old_name;
    Blockbench.showQuickMessage(`"${old_name}" is a locked bone — it cannot be renamed.`, 2200);
    Canvas.updateAll();
  }

  function onFinishedEdit() {
    if (Format.id !== "pck_skin") return;

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

    if (violated) {
      Undo.loadSave(last.before, last.post);
      Undo.history.pop();
      Undo.index = Undo.history.length;
      Blockbench.showQuickMessage("Locked bones cannot be moved or reparented — only their pivots may change.", 2500);
      return;
    }

    if (pivotChanged && Modes.animate) {
      rebuildArmorCubes();
    }
  }

  function onCubeAdded({ object }) {
    if (Format.id !== "pck_skin") return;
    if (!object.box_uv) {
      object.box_uv = true;
    }
  }

  Blockbench.on("change_element_name", onNameChanged);
  Blockbench.on("finished_edit", onFinishedEdit);
  Blockbench.on("add_cube", onCubeAdded);

  track({
    delete() {
      Blockbench.removeListener("change_element_name", onNameChanged);
      Blockbench.removeListener("finished_edit", onFinishedEdit);
      Blockbench.removeListener("add_cube", onCubeAdded);
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

    LOCKED_BONES.forEach((requiredName) => {
      if (!presentBoneNames.has(requiredName)) {
        issues.push({
          name: "Missing or renamed root bone",
          description:
            `The required bone **"${requiredName}"** is missing. ` +
            `Root bones (HEAD, BODY, ARM0, ARM1, LEG0, LEG1) must keep their original names exactly — ` +
            `they cannot be renamed, deleted, or replaced.`,
        });
      }
    });

    Group.all.forEach((group) => {
      if (group.parent instanceof Group) return;
      if (!LOCKED_BONES.has(group.name)) {
        issues.push({
          name: "Unrecognised root bone",
          description:
            `Found an unexpected root bone named **"${group.name}"**. ` +
            `Only the six locked bones (HEAD, BODY, ARM0, ARM1, LEG0, LEG1) may exist at the top level. ` +
            `If you renamed one of those bones, please rename it back to its original name.`,
        });
      }
    });

    Group.all.forEach((group) => {
      if (!(group.parent instanceof Group)) return;
      const parentName = group.parent instanceof Group ? group.parent.name : "?";
      issues.push({
        name: "Nested sub-folder detected",
        description:
          `Found a sub-folder named **"${group.name}"** inside bone **"${parentName}"**. ` +
          `Sub-folders are not allowed — only cubes may exist inside the root bones (HEAD, BODY, ARM0, ARM1, LEG0, LEG1). ` +
          `Please remove or ungroup it before exporting.`,
      });
    });

    Texture.all.forEach((tex) => {
      const w = tex.width;
      const h = tex.height;
      const valid = (w === 64 && h === 64) || (w === 64 && h === 32);
      if (!valid) {
        issues.push({
          name: "Invalid texture size",
          description:
            `Texture **"${tex.name || "unnamed"}"** is ${w}×${h} px. ` +
            `Only **64×64** (Steve/Alex layout) and **64×32** (classic layout) are supported. ` +
            `Please resize the texture to one of those dimensions before exporting.`,
        });
      }
    });

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

    const ROTATION_IGNORED_NAMES = new Set(["cape", "elytraRight", "elytraLeft"]);
    Cube.all.forEach((cube) => {
      if (cube.uuid.startsWith("eeeeeeee") || cube.uuid.startsWith("cccccccc")) return;
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
      name: "PCK Skin",
      description: "Create a Skin then export it to PCK STUDIO",
      target: "Minecraft: Legacy Console",
      icon: "icon-player",
      show_on_start_screen: true,
      confidential: true,
      can_convert_to: false,
      rotate_cubes: true,
      box_uv: true,
      per_texture_uv_size: true,
      optional_box_uv: false,
      single_texture: false,
      bone_rig: true,
      centered_grid: true,
      animated_textures: true,
      animation_mode: true,
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

    Project.texture_width = 64;
    Project.texture_height = 64;

    buildTemplateSkeleton();

    const defaultSkinB64 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAGlQTFRFAAAAKBsLLB8OjFs/OCUSfU0xsHROIBUHRCwXwoZrzJF216OL////QiYdXjIqfz83Dw0UFRMcNzc3KigoPz8/HRooIR0w0tLhycfb8fHwvyUpKiY4q6XBKDQamyIavbrTUVFRdXV17TAsPTNTLwAAACN0Uk5TAP////////////////////////////////////////////+k8FOOAAADn0lEQVR4nO1X227cNhCdEUll0TgXJ3EL5CH//1V9KVCgaW527ToWKTLnDKm1rF1ntTZSIEC1K1G8Hc6NnCOVdqlowaN0rT7Kuku3L9qN2mUAECI/AMDloviFUqvD8RIUvBf1DwbAn0p0o6ngjgboBDYsDiW1d3I8AAzIijqrjg/wghTYERIQYVzvBaXz+wHPzicBgvQDWtBjraUcBED89BIlRCyeO/yCcKJjCZEOAlB3YQQFh4XHJKy7jK5AsVZIQIkxdmOxLOWr9JE6qWmhkleogPCD8TsdxZU8FolqMQmgIPEgAPyvoeNGAky0MsdCw0rEPRxU4cnQF9Pe3TyTi81o7zr0AybLGgDnmt9dxCTg1DhAGHiU6WA8WCC95DmgpfvQGs/OgTLKi+SBgPtzaz/F+w0EHJYA7HBZy6fW+OtHK17TFHTl3xMw3q8QW9f7AHQmwdEAVMHPJDjrLuCO53mVCqdwIwexYEmrIyi/jK9zjrZCQZjXvqlfZ6B6SiG9lkQcjE6sB4RHLpEK+Am6qcN+P1NLz6JNRNSwHbGMdZJ3iMruGpM9QzoG9GC3IeQi+1nMAdhQARi8WCHK09h5TSYNGlKwucLQrgAS398BGGwgh0jPYE7el3Hz1QKbYv/C4DaESQK5C8DjALbiioGrRunDVZUGM6O9cIhWFVncVYHtUMEMZYZP3ppRS4D3VtRjqhqxyBbg1IxXJlu32DCDSYUrsGFJi02ln+cABLbRDcO8Ffo4TWJ3D8fy0NMncoP8l/+a+t7kDD8msaPhRC41Na/2Vd/J/5fYrxi0fVxvAfDIz/Wc+egE9zl1hM4lNH2luvLKhqe6u53f7gd9RbH05B+KRRCTxdvUKWxt5o2YlZItj7Z/55vpMdf/AD8W4O3m98cBvEt/Pg5g3fUTATAnYBO0/ZHk9jzw27xzJ4ksr9/uOw+mibIF+kEq/LcAy2S7L6l+F2CZ7vel9YMAc8JxNMCS8hylwj6+oI0b7IuTvQCkC9J4wMQHZEF37gU4SzWpASFMfEFDzc7M8e/XATCNAwBZe+IDxjBmvOB+gGiJqCcA+UJofEBqbQ2AcHwgQM1PlQ+oURyRVSo0whBuSVWpdA15+qARqxu1MQ5Z8oI6idm8nQ8754HxKi6Z7COubNr+l8V5sK0vz4M3/O4iYSid8QWm9VtmIDvRuKOC8YUX5WLiC3+w0dUcXzTtfE/uABhfeHZZJr5wwaV9JQe40lKCbwlsVIdTtMy7AAAAAElFTkSuQmCC";
    const defaultTex = new Texture({ name: "skin" });
    defaultTex.fromDataURL(defaultSkinB64);
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
        Project.model_identifier = sanitised;
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

  const _origGetTexture = CubeFace.prototype.getTexture;
  CubeFace.prototype.getTexture = function (...args) {
    if (Format.id === "pck_skin" && this.cube) {
      if (this.texture === null) return null;
      if (this.cube.uuid.startsWith("eeeeeeee")) return null;
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
      Canvas.updateAllFaces();
    },
  });

  const _onTextureUpdate = ({ texture }) => {
    if (Format.id !== "pck_skin") return;
    if (texture && _isCapeTexture(texture)) _invalidateCapeThreeTexCache();
    Canvas.updateAllFaces();
  };
  const _onTextureRemoved = ({ texture }) => {
    if (Format.id !== "pck_skin") return;
    if (texture && _isCapeTexture(texture)) _invalidateCapeThreeTexCache();
    Canvas.updateAllFaces();
  };
  Blockbench.on("update_texture", _onTextureUpdate);
  Blockbench.on("finish_edit", _onTextureRemoved);
  track({
    delete() {
      Blockbench.removeListener("update_texture", _onTextureUpdate);
      Blockbench.removeListener("finish_edit", _onTextureRemoved);
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
      "animation.player.idle": {},
      "animation.player.bob": {
        loop: true,
        bones: {
          ARM0: { rotation: [0.0, 0.0, "(math.cos(query.life_time * 103.2) * 2.865) + 2.865"] },
          ARM1: { rotation: [0.0, 0.0, "-((math.cos(query.life_time * 103.2) * 2.865) + 2.865)"] },
        },
      },
      "animation.player.walk": {
        loop: true,
        bones: {
          ARM0: { rotation: ["-math.cos(query.anim_time * 360) * 30", 0, 0] },
          ARM1: { rotation: ["math.cos(query.anim_time * 360) * 30", 0, 0] },
          LEG0: { rotation: ["math.cos(query.anim_time * 360) * 1.4 * 30", 0, 0] },
          LEG1: { rotation: ["math.cos(query.anim_time * 360) * -1.4 * 30", 0, 0] },
        },
      },
      "animation.player.run": {
        loop: true,
        bones: {
          ARM0: { rotation: ["-math.cos(query.anim_time * 720) * 50", 0, 0] },
          ARM1: { rotation: ["math.cos(query.anim_time * 720) * 50", 0, 0] },
          LEG0: { rotation: ["math.cos(query.anim_time * 720) * 1.4 * 50", 0, 0] },
          LEG1: { rotation: ["math.cos(query.anim_time * 720) * -1.4 * 50", 0, 0] },
        },
      },
      "animation.player.sitting": {
        loop: true,
        bones: {
          BODY: { position: [0, -10, 0] },
          HEAD: { position: [0, -10, 0] },
          ARM0: { position: [0, -10, 0] },
          ARM1: { position: [0, -10, 0] },
          LEG0: { rotation: ["-88.5 - this", "18 - this", "-this"], position: [0, -10, 0] },
          LEG1: { rotation: ["-88.5 - this", "-18 - this", "0"], position: [0, -10, 0] },
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
    ARM0: [6, 22, 0],
    ARM1: [-6, 22, 0],
    LEG0: [2, 12, 0],
    LEG1: [-2, 12, 0],
  };

  function rebuildArmorCubes() {
    clearArmorCubes();
    if (!Modes.animate) return;
    if (!Project.pck_armor_cubes) Project.pck_armor_cubes = [];

    function addCube(def, boneName, uuidFn = armorUuid) {
      const bone = Group.all.find((g) => g.name === boneName);
      if (!bone) return;

      const defaultPivot = BONE_DEFAULT_PIVOTS[boneName] || [0, 0, 0];
      const livePivot = bone.origin;
      const dx = livePivot[0] - defaultPivot[0];
      const dy = livePivot[1] - defaultPivot[1];
      const dz = livePivot[2] - defaultPivot[2];

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
      );
    }
    if (armorPieces.chestplate) {
      addCube(
        { name: "armorBody", from: [-4, 12, -2], to: [4, 24, 2], inflate: 1.01, uv_offset: [16, 16], color: 1 },
        "BODY",
      );
      addCube(
        { name: "armorRightArm", from: [-8, 12, -2], to: [-4, 24, 2], inflate: 1, uv_offset: [40, 16], color: 1 },
        "ARM1",
      );
      addCube(
        {
          name: "armorLeftArm",
          from: [4, 12, -2],
          to: [8, 24, 2],
          inflate: 1,
          uv_offset: [40, 16],
          color: 1,
          mirror_uv: true,
        },
        "ARM0",
      );
    }
    if (armorPieces.leggings) {
      addCube(
        { name: "armorLegsBody", from: [-4, 12, -2], to: [4, 24, 2], inflate: 0.51, uv_offset: [16, 48], color: 1 },
        "BODY",
      );
      addCube(
        { name: "armorRightLeg", from: [-4, 0, -2], to: [0, 12, 2], inflate: 0.5, uv_offset: [0, 48], color: 1 },
        "LEG1",
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
      );
    }
    if (armorPieces.boots) {
      addCube(
        { name: "rightBoot", from: [-4, 0, -2], to: [0, 6, 2], inflate: 1, uv_offset: [0, 22], color: 1 },
        "LEG1",
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

  Plugin.register("pck_skin_helper", {
    title: "PCK Skin Helper",
    author: "BehaviorPack",
    icon: "icon-player",
    description: "Create Minecraft Legacy Console skins and export them for PCK Studio",
    about:
      'To get started, click "<b>PCK Skin</b>"<br>└─ You can delete <b>cape.png</b> or replace it with your own.<br>Use "<b>Validate PCK Skin</b>" to make sure it\'ll import correctly.<br>└─ You can also click "<b>Preview</b>" to display Armor placement and animations.<br>Click "<b>Export Legacy Project</b>" and import into PCK Studio.<br><br><img src="data:image/png;base64,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"><br><p class="note"><i>Note that your Skin Texture can <b>not</b> be greater than 32kb and your UV can <b>only</b> be 64x64 or 64x32.</i></p>',
    version: "1.0.0",
    min_version: "4.0.0",
    creation_date: "2026-03-11",
    variant: "both",
    await_loading: true,

    onload() {
      this.actionNew = new Action("new_pck_skin", {
        name: "PCK Skin",
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
    },

    onunload() {
      this.actionNew.delete();
      this.actionValidate.delete();
      registered.forEach((item) => {
        if (typeof item.delete === "function") item.delete();
        else if (typeof item.remove === "function") item.remove();
      });
      registered.splice(0, Infinity);
    },
  });
})();
