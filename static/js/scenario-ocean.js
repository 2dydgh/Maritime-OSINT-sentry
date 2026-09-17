/* Visual sea only. Saved AIS tracks and collision metrics remain in nautical miles. */
(function () {
    'use strict';
    window.ScenarioOcean = {
        create(scene, renderer, extent) {
            // Reuse the roll viewer's wave field with a fixed, mild visual preset.
            // Scene ships are enlarged, so this scale is illustrative, not metres.
            const motionScale = extent / 22 / 32;
            const waves = window.Gerstner?.buildWaves({waveHeight:1.2,wavePeriod:8,waveDirection:35}) || [];
            const sun = new THREE.Vector3(-.55, .32, -.7).normalize();
            const sky = new THREE.Sky();
            sky.scale.setScalar(extent * 160);
            const uniforms = sky.material.uniforms;
            uniforms.turbidity.value = 3;
            uniforms.rayleigh.value = 1.8;
            uniforms.mieCoefficient.value = .003;
            uniforms.mieDirectionalG.value = .8;
            uniforms.sunPosition.value.copy(sun);
            scene.add(sky);
            scene.fog = new THREE.Fog(0xa9c5d4, extent * 8, extent * 70);
            const normal = new THREE.TextureLoader().load('textures/waternormals.jpg');
            normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
            normal.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            const water = new THREE.Water(new THREE.PlaneGeometry(extent * 180, extent * 180), {
                textureWidth: 256, textureHeight: 256, waterNormals: normal,
                sunDirection: sun, sunColor: 0xfff1dc, waterColor: 0x125064,
                distortionScale: 1.6, fog: true
            });
            water.rotation.x = -Math.PI / 2;
            water.material.uniforms.size.value = 2;
            scene.add(water);
            const light = new THREE.DirectionalLight(0xfff4e2, 1.3);
            light.position.copy(sun).multiplyScalar(extent);
            scene.add(light);
            return {
                update(seconds) { water.material.uniforms.time.value = seconds; },
                attitude(position, heading, seconds) {
                    if (!waves.length) return {roll:0,pitch:0,heave:0};
                    const x=position.x/motionScale,y=-position.z/motionScale;
                    const fx=Math.cos(heading),fy=Math.sin(heading),bx=Math.sin(heading),by=-Math.cos(heading);
                    const height=(dx,dy)=>Gerstner.heightAt(waves,x+dx,y+dy,seconds);
                    const clamp=(value,limit)=>Math.max(-limit,Math.min(limit,value));
                    return {
                        roll:clamp(-Math.atan2(height(bx*4,by*4)-height(-bx*4,-by*4),8),Math.PI/36),
                        pitch:clamp(Math.atan2(height(fx*16,fy*16)-height(-fx*16,-fy*16),32),Math.PI/72),
                        heave:height(0,0)*motionScale*.55
                    };
                },
                dispose() { water.dispose(); normal.dispose(); }
            };
        }
    };
})();
