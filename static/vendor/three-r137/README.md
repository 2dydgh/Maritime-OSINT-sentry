# Three.js r137 ocean dependencies

`Water.js` and `Sky.js` are copied from the Three.js 0.137.0 `examples/js/objects/` directory. They match the Three.js version loaded by `static/index.html`. See `LICENSE` for the upstream MIT license.

Local change: `Water.dispose()` releases its private reflection render target. The scenario viewer also disposes its own normal texture, geometry and material.

`../../textures/waternormals.jpg` comes from the same upstream r137 tag, `examples/textures/waternormals.jpg`.
