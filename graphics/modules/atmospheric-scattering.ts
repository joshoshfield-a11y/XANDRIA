// XANDRIA Atmospheric Scattering Module
// OP-22 MATRIX: Preetham sky model with dynamic lighting

export interface AtmosphericConfig {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunElevation: number;
  sunAzimuth: number;
  skyScale: number;
  exposure: number;
}

export interface LightingConfig {
  sunIntensity: number;
  ambientIntensity: number;
  shadowMapSize: number;
  toneMapping: string;
}

export class AtmosphericScattering {
  private config: AtmosphericConfig;
  private lightingConfig: LightingConfig;
  private sky: any;
  private sun: any;
  private sunLight: any;
  private ambientLight: any;

  constructor(config: AtmosphericConfig, lightingConfig: LightingConfig) {
    this.config = config;
    this.lightingConfig = lightingConfig;
  }

  // Initialize the sky system
  initializeSky(): any {
    // Create sky using Three.js Sky shader
    const Sky = (globalThis as any).THREE.Sky || {
      material: {
        uniforms: {
          turbidity: { value: 10 },
          rayleigh: { value: 3 },
          mieCoefficient: { value: 0.005 },
          mieDirectionalG: { value: 0.7 },
          sunPosition: { value: new (globalThis as any).THREE.Vector3() }
        }
      },
      scale: { setScalar: (s: number) => {} }
    };

    this.sky = new Sky();
    this.sky.scale.setScalar(this.config.skyScale);

    // Initialize sun position
    this.sun = new (globalThis as any).THREE.Vector3();

    this.updateSkyParameters();
    return this.sky;
  }

  // Initialize lighting system
  initializeLighting(): { sunLight: any; ambientLight: any } {
    // Create directional sun light
    this.sunLight = new (globalThis as any).THREE.DirectionalLight(
      0xffffff,
      this.lightingConfig.sunIntensity
    );

    // Configure shadows
    this.sunLight.castShadow = true;
    this.sunLight.shadow.camera.left = -50;
    this.sunLight.shadow.camera.right = 50;
    this.sunLight.shadow.camera.top = 50;
    this.sunLight.shadow.camera.bottom = -50;
    this.sunLight.shadow.camera.far = 500;
    this.sunLight.shadow.mapSize.width = this.lightingConfig.shadowMapSize;
    this.sunLight.shadow.mapSize.height = this.lightingConfig.shadowMapSize;

    // Position sun light
    this.updateSunPosition();

    // Create ambient light
    this.ambientLight = new (globalThis as any).THREE.AmbientLight(
      0x404040,
      this.lightingConfig.ambientIntensity
    );

    return {
      sunLight: this.sunLight,
      ambientLight: this.ambientLight
    };
  }

  // Update sky shader parameters
  updateSkyParameters(): void {
    if (!this.sky) return;

    const uniforms = this.sky.material.uniforms;
    uniforms.turbidity.value = this.config.turbidity;
    uniforms.rayleigh.value = this.config.rayleigh;
    uniforms.mieCoefficient.value = this.config.mieCoefficient;
    uniforms.mieDirectionalG.value = this.config.mieDirectionalG;

    this.updateSunPosition();
    uniforms.sunPosition.value.copy(this.sun);
  }

  // Calculate sun position from spherical coordinates
  private updateSunPosition(): void {
    const phi = (globalThis as any).THREE.MathUtils.degToRad(90 - this.config.sunElevation);
    const theta = (globalThis as any).THREE.MathUtils.degToRad(this.config.sunAzimuth);

    this.sun.setFromSphericalCoords(1, phi, theta);

    if (this.sunLight) {
      this.sunLight.position.copy(this.sun).multiplyScalar(100);
    }
  }

  // Update atmospheric conditions (time of day, weather)
  updateAtmosphere(timeOfDay: number, weatherConditions: WeatherConditions): void {
    // Time-based sky color transitions
    const timeFactor = Math.sin(timeOfDay * Math.PI * 2);

    // Adjust turbidity based on weather
    this.config.turbidity = this.calculateTurbidity(weatherConditions);

    // Adjust sun elevation based on time
    this.config.sunElevation = 90 - (timeOfDay * 180); // 0 = midnight, 0.5 = noon

    this.updateSkyParameters();
  }

  private calculateTurbidity(conditions: WeatherConditions): number {
    let baseTurbidity = 10; // Clear sky

    if (conditions.cloudy) baseTurbidity += 5;
    if (conditions.foggy) baseTurbidity += 10;
    if (conditions.rainy) baseTurbidity += 15;

    return Math.min(baseTurbidity, 20);
  }

  // Get current sky color for reflections/water
  getSkyColor(): { r: number; g: number; b: number } {
    // Simplified sky color calculation based on sun position
    const elevation = this.config.sunElevation;
    const azimuth = this.config.sunAzimuth;

    // Dawn/dusk colors
    if (elevation < 10) {
      return { r: 0.8, g: 0.4, b: 0.2 }; // Warm orange
    }
    // Daytime
    else if (elevation > 20) {
      return { r: 0.5, g: 0.7, b: 1.0 }; // Blue sky
    }
    // Horizon
    else {
      return { r: 0.9, g: 0.6, b: 0.3 }; // Golden
    }
  }

  // Configure renderer for atmospheric rendering
  configureRenderer(renderer: any): void {
    // Set tone mapping
    renderer.toneMapping = this.getToneMappingConstant(this.lightingConfig.toneMapping);
    renderer.toneMappingExposure = this.config.exposure;

    // Enable shadows
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = (globalThis as any).THREE.PCFSoftShadowMap;
  }

  private getToneMappingConstant(mapping: string): any {
    const THREE = globalThis as any;
    switch (mapping) {
      case 'ACESFilmic': return THREE.ACESFilmicToneMapping;
      case 'Linear': return THREE.LinearToneMapping;
      case 'Reinhard': return THREE.ReinhardToneMapping;
      case 'Cineon': return THREE.CineonToneMapping;
      default: return THREE.ACESFilmicToneMapping;
    }
  }

  // Create water surface with sky reflections
  createWaterSurface(size: number = 1000): any {
    const geometry = new (globalThis as any).THREE.PlaneGeometry(size, size);

    const skyColor = this.getSkyColor();
    const water = new (globalThis as any).Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: new (globalThis as any).THREE.TextureLoader().load(
        'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/waternormals.jpg',
        (texture: any) => {
          texture.wrapS = texture.wrapT = (globalThis as any).THREE.RepeatWrapping;
        }
      ),
      sunDirection: this.sun,
      sunColor: 0xffffff,
      waterColor: new (globalThis as any).THREE.Color(skyColor.r * 0.1, skyColor.g * 0.2, skyColor.b * 0.3),
      distortionScale: 3.7,
      fog: false
    });

    water.rotation.x = -Math.PI / 2;
    return water;
  }

  // Update lighting based on time of day
  updateLighting(timeOfDay: number): void {
    // Adjust sun intensity based on elevation
    const elevation = this.config.sunElevation;
    const intensity = Math.max(0.1, Math.sin((elevation / 180) * Math.PI));

    if (this.sunLight) {
      this.sunLight.intensity = this.lightingConfig.sunIntensity * intensity;
    }

    // Adjust ambient light
    if (this.ambientLight) {
      this.ambientLight.intensity = this.lightingConfig.ambientIntensity * (0.3 + intensity * 0.7);
    }
  }

  // Get atmospheric data for external systems
  getAtmosphericData(): AtmosphericData {
    return {
      skyColor: this.getSkyColor(),
      sunPosition: {
        x: this.sun.x,
        y: this.sun.y,
        z: this.sun.z
      },
      turbidity: this.config.turbidity,
      sunElevation: this.config.sunElevation,
      sunAzimuth: this.config.sunAzimuth
    };
  }

  dispose(): void {
    // Clean up resources
    if (this.sky) {
      this.sky.material.dispose();
    }
    if (this.sunLight) {
      // Dispose shadow map if needed
    }
  }
}

// Predefined atmospheric presets
export const ATMOSPHERIC_PRESETS = {
  clearDay: {
    turbidity: 2,
    rayleigh: 3,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    sunElevation: 45,
    sunAzimuth: 180,
    skyScale: 450000,
    exposure: 1.0
  },
  sunset: {
    turbidity: 10,
    rayleigh: 3,
    mieCoefficient: 0.01,
    mieDirectionalG: 0.7,
    sunElevation: 5,
    sunAzimuth: 180,
    skyScale: 450000,
    exposure: 1.2
  },
  stormy: {
    turbidity: 20,
    rayleigh: 1,
    mieCoefficient: 0.1,
    mieDirectionalG: 0.7,
    sunElevation: 30,
    sunAzimuth: 180,
    skyScale: 450000,
    exposure: 0.8
  }
};

export const LIGHTING_PRESETS = {
  daytime: {
    sunIntensity: 1.5,
    ambientIntensity: 0.3,
    shadowMapSize: 4096,
    toneMapping: 'ACESFilmic'
  },
  nighttime: {
    sunIntensity: 0.1,
    ambientIntensity: 0.1,
    shadowMapSize: 2048,
    toneMapping: 'Reinhard'
  }
};

interface WeatherConditions {
  cloudy: boolean;
  foggy: boolean;
  rainy: boolean;
}

interface AtmosphericData {
  skyColor: { r: number; g: number; b: number };
  sunPosition: { x: number; y: number; z: number };
  turbidity: number;
  sunElevation: number;
  sunAzimuth: number;
}