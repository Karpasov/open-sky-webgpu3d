const app = document.querySelector( '#app' );
const status = document.querySelector( '#status' );
const statusMessage = document.querySelector( '#status-message' );
const controlsPanel = document.querySelector( '#controls' );
const seaInput = document.querySelector( '#sea-state' );
const seaOutput = document.querySelector( '#sea-output' );
const timeInput = document.querySelector( '#time-of-day' );
const timeOutput = document.querySelector( '#time-output' );
const driftEnabled = document.querySelector( '#drift-enabled' );
const driftSpeed = document.querySelector( '#drift-speed' );
const driftOutput = document.querySelector( '#drift-output' );
const fpsOutput = document.querySelector( '#fps-output' );

function showFailure( title, detail ) {
  status.classList.remove( 'is-hidden' );
  status.classList.add( 'is-error' );
  status.querySelector( 'h1' ).textContent = title;
  statusMessage.innerHTML = detail;
}

function formatTime( hours ) {
  const totalMinutes = Math.round( Number( hours ) * 60 ) % ( 24 * 60 );
  const hh = Math.floor( totalMinutes / 60 ).toString().padStart( 2, '0' );
  const mm = ( totalMinutes % 60 ).toString().padStart( 2, '0' );
  return `${ hh }:${ mm }`;
}

function seaLabel( value ) {
  if ( value < 0.48 ) return 'Calm';
  if ( value < 0.85 ) return 'Gentle';
  if ( value < 1.2 ) return 'Moderate';
  if ( value < 1.52 ) return 'Rough';
  return 'Heavy';
}

async function start() {
  if ( ! window.isSecureContext || ! navigator.gpu ) {
    showFailure(
      'WebGPU is required',
      'Open this page in a current WebGPU-capable browser over <strong>localhost</strong> or HTTPS. No fallback renderer is used.'
    );
    return;
  }

  statusMessage.textContent = 'Requesting a high-performance GPU…';

  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
  } catch ( error ) {
    showFailure( 'WebGPU could not start', 'The browser exposed WebGPU, but GPU access failed. Check browser graphics settings and reload.' );
    return;
  }

  if ( ! adapter ) {
    showFailure( 'No WebGPU adapter', 'A compatible GPU adapter was not available. No fallback renderer is used.' );
    return;
  }

  statusMessage.textContent = 'Loading the ocean shaders…';

  let THREE, TSL, OrbitControls, CSS3DRenderer, CSS3DObject, bloom;
  try {
    [ THREE, TSL, { OrbitControls }, { CSS3DRenderer, CSS3DObject }, { bloom } ] = await Promise.all( [
      import( 'three/webgpu' ),
      import( 'three/tsl' ),
      import( 'three/addons/controls/OrbitControls.js' ),
      import( 'three/addons/renderers/CSS3DRenderer.js' ),
      import( 'three/addons/tsl/display/BloomNode.js' )
    ] );
  } catch ( error ) {
    showFailure( 'Modules failed to load', 'The pinned Three.js modules could not be downloaded. Check the network connection, then reload.' );
    return;
  }

  const {
    Fn, cameraPosition, clamp, cos, cross, dot, exp, float, int, length, max, mix,
    mx_fractal_noise_float, normalize, pass, positionGeometry, positionWorld,
    pow, reflect, sin, smoothstep, sqrt, uniform, varying, vec2, vec3, vec4
  } = TSL;

  const isConstrained = matchMedia( '(pointer: coarse)' ).matches || innerWidth < 760;
  const reducedMotion = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;
  const maxDpr = isConstrained ? 1.35 : 1.65;
  const minDpr = 0.72;
  let renderDpr = Math.min( devicePixelRatio || 1, maxDpr );

  const renderer = new THREE.WebGPURenderer( {
    antialias: ! isConstrained,
    alpha: false,
    powerPreference: 'high-performance'
  } );
  renderer.setPixelRatio( renderDpr );
  renderer.setSize( innerWidth, innerHeight );
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute( 'aria-label', 'Procedural ocean. Drag to look around and pinch or scroll to zoom.' );
  renderer.domElement.tabIndex = 0;
  app.append( renderer.domElement );

  try {
    await renderer.init();
  } catch ( error ) {
    renderer.dispose();
    showFailure( 'WebGPU initialization failed', 'The GPU device could not be initialized. Update the browser or graphics driver and reload.' );
    return;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera( 52, innerWidth / innerHeight, 0.15, 1000 );
  camera.position.set( 0, 5.8, 17 );

  const cssRenderer = new CSS3DRenderer();
  cssRenderer.setSize( innerWidth, innerHeight );
  cssRenderer.domElement.className = 'css3d-layer';
  cssRenderer.domElement.style.pointerEvents = 'none';
  app.append( cssRenderer.domElement );

  const orbit = new OrbitControls( camera, renderer.domElement );
  orbit.target.set( 0, 0.6, -16 );
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.045;
  orbit.enablePan = false;
  orbit.minDistance = 7;
  orbit.maxDistance = 44;
  orbit.minPolarAngle = 0.88;
  orbit.maxPolarAngle = 1.515;
  orbit.autoRotate = ! reducedMotion;
  orbit.autoRotateSpeed = Number( driftSpeed.value );
  orbit.update();

  // These uniforms are deliberately shared by the water and the single analytic sky function.
  const uTime = uniform( 0 );
  const uSeaState = uniform( Number( seaInput.value ) );
  const uTimeOfDay = uniform( Number( timeInput.value ) / 24 );
  const uSunDirection = uniform( new THREE.Vector3() );

  function updateSun() {
    const day = Number( timeInput.value ) / 24;
    const solarAngle = ( day - 0.25 ) * Math.PI * 2;
    const elevation = Math.sin( solarAngle );
    const azimuth = solarAngle * 0.58 - 0.7;
    uTimeOfDay.value = day;
    uSunDirection.value.set(
      Math.cos( azimuth ) * Math.cos( Math.asin( elevation ) ),
      elevation,
      Math.sin( azimuth ) * Math.cos( Math.asin( elevation ) )
    ).normalize();
  }
  updateSun();

  // One sky function serves the visible dome and every reflected water ray.
  const analyticSky = Fn( ( [ direction ] ) => {
    const d = normalize( vec3( direction ) );
    const h = clamp( d.y, 0.0, 1.0 );
    const t = uTimeOfDay;

    const daylight = smoothstep( 0.205, 0.34, t )
      .mul( smoothstep( 0.205, 0.34, t ).sub( smoothstep( 0.66, 0.795, t ) ) );
    const dawn = exp( pow( t.sub( 0.25 ).div( 0.072 ), 2.0 ).negate() );
    const dusk = exp( pow( t.sub( 0.75 ).div( 0.082 ), 2.0 ).negate() );
    const twilight = max( dawn, dusk );

    const nightHorizon = vec3( 0.035, 0.055, 0.105 );
    const nightZenith = vec3( 0.002, 0.006, 0.018 );
    const dayHorizon = vec3( 0.58, 0.76, 0.91 );
    const dayZenith = vec3( 0.075, 0.255, 0.59 );
    const warmHorizon = vec3( 1.04, 0.34, 0.115 );
    const warmZenith = vec3( 0.14, 0.075, 0.24 );

    const horizonColor = mix( mix( nightHorizon, dayHorizon, daylight ), warmHorizon, twilight.mul( 0.82 ) );
    const zenithColor = mix( mix( nightZenith, dayZenith, daylight ), warmZenith, twilight.mul( 0.72 ) );
    const gradient = mix( horizonColor, zenithColor, pow( h, 0.42 ) );

    const horizonHaze = exp( h.mul( -22.0 ) );
    const hazeColor = mix( horizonColor, vec3( 0.88, 0.56, 0.34 ), twilight.mul( 0.28 ) );
    const sky = mix( gradient, hazeColor, horizonHaze.mul( 0.48 ) ).toVar();

    const cloudPlane = d.xz.div( max( h.add( 0.14 ), 0.14 ) ).mul( 0.62 );
    const cloudNoise = mx_fractal_noise_float(
      vec3( cloudPlane.x.add( uTime.mul( 0.008 ) ), cloudPlane.y.sub( uTime.mul( 0.0045 ) ), uTime.mul( 0.011 ) ),
      int( 5 ), 2.03, 0.515
    ).mul( 0.5 ).add( 0.5 );
    const cloudMask = smoothstep( 0.54, 0.73, cloudNoise )
      .mul( smoothstep( 0.015, 0.16, h ) )
      .mul( smoothstep( 0.72, 1.0, h ).oneMinus() );
    const cloudLight = pow( max( dot( d, uSunDirection ), 0.0 ), 12.0 );
    const cloudColor = mix( vec3( 0.035, 0.045, 0.075 ), vec3( 1.12, 1.16, 1.18 ), daylight )
      .add( vec3( 1.35, 0.55, 0.22 ).mul( twilight.mul( 0.5 ).add( cloudLight.mul( 0.38 ) ) ) );
    sky.assign( mix( sky, cloudColor, cloudMask.mul( 0.56 ) ) );

    const sunDot = max( dot( d, uSunDirection ), 0.0 );
    const sunAbove = smoothstep( -0.085, 0.025, uSunDirection.y );
    const halo = pow( sunDot, 72.0 ).mul( sunAbove ).mul( daylight.mul( 0.48 ).add( twilight.mul( 1.2 ) ) );
    const disk = smoothstep( 0.99972, 0.99988, sunDot ).mul( sunAbove );
    const sunColor = mix( vec3( 2.9, 0.52, 0.12 ), vec3( 12.0, 8.1, 4.0 ), daylight );

    sky.addAssign( sunColor.mul( halo.mul( 0.42 ).add( disk ) ) );
    return sky;
  } );

  // Exactly five deep-water Gerstner components. No texture or mutable wave-count loop is used.
  const W0 = { direction: [ 0.94, 0.34 ], amplitude: 0.72, wavelength: 18.0, steepness: 0.40, speed: 0.94 };
  const W1 = { direction: [ 0.36, 0.93 ], amplitude: 0.39, wavelength: 10.5, steepness: 0.32, speed: 1.07 };
  const W2 = { direction: [ -0.54, 0.84 ], amplitude: 0.23, wavelength: 6.8, steepness: 0.27, speed: 1.16 };
  const W3 = { direction: [ -0.91, -0.41 ], amplitude: 0.13, wavelength: 4.1, steepness: 0.21, speed: 1.22 };
  const W4 = { direction: [ 0.70, -0.71 ], amplitude: 0.075, wavelength: 2.45, steepness: 0.17, speed: 1.31 };

  function waveTerms( p, wave ) {
    const direction = new THREE.Vector2( wave.direction[ 0 ], wave.direction[ 1 ] ).normalize();
    const d = vec2( direction.x, direction.y );
    const k = ( Math.PI * 2 ) / wave.wavelength;
    const amplitude = float( wave.amplitude ).mul( uSeaState );
    const phase = dot( d, p ).mul( k ).sub(
      uTime.mul( sqrt( 9.81 * k ) ).mul( wave.speed ).mul( mix( 0.88, 1.1, clamp( uSeaState.div( 1.8 ), 0.0, 1.0 ) ) )
    );
    const horizontal = amplitude.mul( wave.steepness ).mul( mix( 0.72, 1.0, clamp( uSeaState.div( 1.8 ), 0.0, 1.0 ) ) );
    return { d, k, amplitude, horizontal, s: sin( phase ), c: cos( phase ) };
  }

  function addWavePosition( result, p, wave ) {
    const w = waveTerms( p, wave );
    result.x.addAssign( w.d.x.mul( w.horizontal ).mul( w.c ) );
    result.y.addAssign( w.d.y.mul( w.horizontal ).mul( w.c ) );
    result.z.addAssign( w.amplitude.mul( w.s ) );
  }

  function addWaveDerivatives( tangentX, tangentY, p, wave ) {
    const w = waveTerms( p, wave );
    const horizontalSlope = w.horizontal.mul( w.k ).mul( w.s );
    const verticalSlope = w.amplitude.mul( w.k ).mul( w.c );

    tangentX.addAssign( vec3(
      w.d.x.mul( w.d.x ).mul( horizontalSlope ).negate(),
      w.d.x.mul( w.d.y ).mul( horizontalSlope ).negate(),
      w.d.x.mul( verticalSlope )
    ) );
    tangentY.addAssign( vec3(
      w.d.x.mul( w.d.y ).mul( horizontalSlope ).negate(),
      w.d.y.mul( w.d.y ).mul( horizontalSlope ).negate(),
      w.d.y.mul( verticalSlope )
    ) );
  }

  const gerstnerPosition = Fn( ( [ coordinate ] ) => {
    const p = vec2( coordinate );
    const result = vec3( p.x, p.y, 0.0 ).toVar();
    addWavePosition( result, p, W0 );
    addWavePosition( result, p, W1 );
    addWavePosition( result, p, W2 );
    addWavePosition( result, p, W3 );
    addWavePosition( result, p, W4 );
    return result;
  } );

  const analyticSwellNormal = Fn( ( [ coordinate ] ) => {
    const p = vec2( coordinate );
    const tangentX = vec3( 1.0, 0.0, 0.0 ).toVar();
    const tangentY = vec3( 0.0, 1.0, 0.0 ).toVar();
    addWaveDerivatives( tangentX, tangentY, p, W0 );
    addWaveDerivatives( tangentX, tangentY, p, W1 );
    addWaveDerivatives( tangentX, tangentY, p, W2 );
    addWaveDerivatives( tangentX, tangentY, p, W3 );
    addWaveDerivatives( tangentX, tangentY, p, W4 );
    return normalize( cross( tangentX, tangentY ) );
  } );

  // Animated MaterialX gradient-noise FBM supplies only fine capillary normal detail;
  // the large swell normal above remains analytic and stable at every distance.
  const capillaryFbm = Fn( ( [ coordinate ] ) => {
    const p = vec2( coordinate ).mul( 0.88 );
    return mx_fractal_noise_float(
      vec3( p.x.add( uTime.mul( 0.072 ) ), p.y.sub( uTime.mul( 0.041 ) ), uTime.mul( 0.13 ) ),
      int( 3 ), 2.16, 0.5
    );
  } );

  const segments = isConstrained ? 192 : 288;
  const waterGeometry = new THREE.PlaneGeometry( 340, 340, segments, segments );
  const waterMaterial = new THREE.MeshBasicNodeMaterial( { side: THREE.FrontSide } );
  waterMaterial.positionNode = gerstnerPosition( positionGeometry.xy );

  const waterCoordinate = varying( positionGeometry.xy );
  const waterColor = Fn( () => {
    const p = waterCoordinate;
    const displaced = gerstnerPosition( p );
    const swellNormal = analyticSwellNormal( p );

    const epsilon = 0.055;
    const noise0 = capillaryFbm( p );
    const noiseX = capillaryFbm( p.add( vec2( epsilon, 0.0 ) ) );
    const noiseY = capillaryFbm( p.add( vec2( 0.0, epsilon ) ) );
    const detailStrength = mix( 0.035, 0.082, clamp( uSeaState.div( 1.8 ), 0.0, 1.0 ) );
    const detailX = noiseX.sub( noise0 ).div( epsilon ).mul( detailStrength );
    const detailY = noiseY.sub( noise0 ).div( epsilon ).mul( detailStrength );
    const localNormal = normalize( swellNormal.sub( vec3( detailX, detailY, 0.0 ) ) );

    // The plane is rotated -90° on X and translated -50m on world Z.
    const worldPosition = vec3( displaced.x, displaced.z, displaced.y.negate().sub( 50.0 ) );
    const normalWorld = normalize( vec3( localNormal.x, localNormal.z, localNormal.y.negate() ) );
    const viewDirection = normalize( cameraPosition.sub( worldPosition ) );
    const reflectionDirection = reflect( viewDirection.negate(), normalWorld );
    const reflectedSky = analyticSky( reflectionDirection );

    const noV = clamp( dot( normalWorld, viewDirection ), 0.0, 1.0 );
    const fresnel = float( 0.018 ).add( pow( noV.oneMinus(), 5.0 ).mul( 0.982 ) );
    const height = displaced.z;
    const valley = smoothstep( 0.1, 1.2, height.negate() );
    const crest = smoothstep( 0.18, 1.35, height );

    const deepWater = vec3( 0.004, 0.026, 0.043 );
    const bodyWater = vec3( 0.012, 0.115, 0.16 );
    const subsurface = mix( deepWater, bodyWater, smoothstep( -1.0, 0.72, height ) )
      .mul( mix( 1.0, 0.46, valley ) );
    const color = mix( subsurface, reflectedSky, fresnel ).toVar();

    const sunAbove = smoothstep( -0.08, 0.03, uSunDirection.y );
    const halfVector = normalize( viewDirection.add( uSunDirection ) );
    const calmness = clamp( uSeaState.div( 1.8 ), 0.0, 1.0 ).oneMinus();
    const glitterPower = mix( 165.0, 520.0, calmness );
    const sunGlitter = pow( max( dot( normalWorld, halfVector ), 0.0 ), glitterPower )
      .mul( sunAbove )
      .mul( mix( 2.3, 7.2, calmness ) )
      .mul( noise0.mul( 0.2 ).add( 0.9 ) );
    const glitterColor = mix( vec3( 1.6, 0.42, 0.1 ), vec3( 4.8, 3.6, 2.15 ), smoothstep( 0.1, 0.55, uSunDirection.y ) );
    color.addAssign( glitterColor.mul( sunGlitter ) );

    const backlightAlignment = pow( max( dot( viewDirection.negate(), uSunDirection ), 0.0 ), 3.0 );
    const backlitCrest = crest.mul( backlightAlignment ).mul( noV.oneMinus().mul( 0.72 ).add( 0.18 ) ).mul( sunAbove );
    color.addAssign( vec3( 0.12, 0.72, 0.68 ).mul( backlitCrest.mul( 1.5 ) ) );

    const cameraDistance = length( worldPosition.xz.sub( cameraPosition.xz ) );
    const horizonBlend = smoothstep( 76.0, 196.0, cameraDistance );
    color.assign( mix( color, reflectedSky, horizonBlend.mul( 0.56 ) ) );

    return vec4( color, 1.0 );
  } );
  waterMaterial.colorNode = waterColor();

  const water = new THREE.Mesh( waterGeometry, waterMaterial );
  water.rotation.x = -Math.PI / 2;
  water.position.z = -50;
  water.frustumCulled = false;
  scene.add( water );

  const skyMaterial = new THREE.MeshBasicNodeMaterial( {
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false
  } );
  skyMaterial.colorNode = analyticSky( normalize( positionWorld.sub( cameraPosition ) ) );
  const sky = new THREE.Mesh( new THREE.SphereGeometry( 600, 64, 32 ), skyMaterial );
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  scene.add( sky );

  // A physical, texture-free 3D billboard. The Hebrew copy is rendered by CSS3D
  // so it remains typographically sharp while sharing the exact scene camera.
  const signGroup = new THREE.Group();
  signGroup.position.set( 0, 9.0, -48 );

  const signPanelMaterial = new THREE.MeshBasicNodeMaterial();
  signPanelMaterial.colorNode = vec3( 0.004, 0.014, 0.026 );

  const signFrameMaterial = new THREE.MeshBasicNodeMaterial();
  signFrameMaterial.colorNode = vec3( 3.8, 0.78, 0.055 );

  const signPostMaterial = new THREE.MeshBasicNodeMaterial();
  signPostMaterial.colorNode = vec3( 0.055, 0.075, 0.09 );

  const signPanel = new THREE.Mesh( new THREE.BoxGeometry( 29.0, 9.5, 0.72 ), signPanelMaterial );
  signPanel.renderOrder = 1;
  signGroup.add( signPanel );

  function addSignBox( width, height, depth, x, y, z, material ) {
    const part = new THREE.Mesh( new THREE.BoxGeometry( width, height, depth ), material );
    part.position.set( x, y, z );
    signGroup.add( part );
    return part;
  }

  addSignBox( 29.8, 0.46, 0.38, 0, 4.84, 0.48, signFrameMaterial );
  addSignBox( 29.8, 0.46, 0.38, 0, -4.84, 0.48, signFrameMaterial );
  addSignBox( 0.46, 9.25, 0.38, -14.67, 0, 0.48, signFrameMaterial );
  addSignBox( 0.46, 9.25, 0.38, 14.67, 0, 0.48, signFrameMaterial );

  addSignBox( 0.76, 4.3, 0.76, -9.5, -6.9, -0.1, signPostMaterial );
  addSignBox( 0.76, 4.3, 0.76, 9.5, -6.9, -0.1, signPostMaterial );
  addSignBox( 2.6, 0.42, 1.8, -9.5, -9.0, -0.1, signPostMaterial );
  addSignBox( 2.6, 0.42, 1.8, 9.5, -9.0, -0.1, signPostMaterial );

  const signElement = document.createElement( 'div' );
  signElement.className = 'event-sign-copy';
  signElement.dir = 'rtl';
  signElement.lang = 'he';
  signElement.style.pointerEvents = 'none';
  signElement.setAttribute( 'role', 'img' );
  signElement.setAttribute( 'aria-label', 'גמר המונדיאל באשבל!!!' );
  signElement.innerHTML = '<span class="sign-line-one" aria-hidden="true">גמר המונדיאל</span><span class="sign-line-two" aria-hidden="true">באשבל!!!</span>';

  const signCopy = new CSS3DObject( signElement );
  signCopy.position.set( 0, 0, 0.39 );
  signCopy.scale.setScalar( 0.022 );
  signGroup.add( signCopy );
  scene.add( signGroup );

  const renderPipeline = new THREE.RenderPipeline( renderer );
  const scenePass = pass( scene, camera );
  const sceneColor = scenePass.getTextureNode( 'output' );
  const bloomPass = bloom( sceneColor, 0.18, 0.34, 1.05 );
  bloomPass.setResolutionScale( isConstrained ? 0.32 : 0.42 );
  renderPipeline.outputNode = sceneColor.add( bloomPass );

  function resize() {
    const width = Math.max( 1, app.clientWidth );
    const height = Math.max( 1, app.clientHeight );
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio( renderDpr );
    renderer.setSize( width, height, false );
    cssRenderer.setSize( width, height );
  }

  let resizeQueued = false;
  const queueResize = () => {
    if ( resizeQueued ) return;
    resizeQueued = true;
    requestAnimationFrame( () => {
      resizeQueued = false;
      resize();
    } );
  };
  const resizeObserver = new ResizeObserver( queueResize );
  resizeObserver.observe( app );
  window.addEventListener( 'resize', queueResize, { passive: true } );
  window.visualViewport?.addEventListener( 'resize', queueResize, { passive: true } );

  seaInput.addEventListener( 'input', () => {
    uSeaState.value = Number( seaInput.value );
    seaOutput.textContent = seaLabel( seaInput.value );
  } );
  timeInput.addEventListener( 'input', () => {
    timeOutput.textContent = formatTime( timeInput.value );
    updateSun();
  } );
  driftEnabled.addEventListener( 'change', () => {
    orbit.autoRotate = driftEnabled.checked && ! reducedMotion;
    driftSpeed.disabled = ! driftEnabled.checked;
  } );
  driftSpeed.addEventListener( 'input', () => {
    orbit.autoRotateSpeed = Number( driftSpeed.value );
    driftOutput.textContent = `${ Number( driftSpeed.value ).toFixed( 2 ) }×`;
  } );

  seaOutput.textContent = seaLabel( seaInput.value );
  timeOutput.textContent = formatTime( timeInput.value );
  if ( reducedMotion ) {
    driftEnabled.checked = false;
    driftSpeed.disabled = true;
  }

  let paused = document.hidden;
  let lastTime = performance.now();
  let fpsWindowStart = lastTime;
  let fpsFrames = 0;
  let lowFpsSeconds = 0;
  let highFpsSeconds = 0;

  document.addEventListener( 'visibilitychange', () => {
    paused = document.hidden;
    lastTime = performance.now();
    fpsWindowStart = lastTime;
    fpsFrames = 0;
    if ( ! paused ) fpsOutput.textContent = '— FPS';
  } );

  function adaptResolution( fps, sampleSeconds ) {
    if ( fps < 42 ) {
      lowFpsSeconds += sampleSeconds;
      highFpsSeconds = 0;
    } else if ( fps > 57 ) {
      highFpsSeconds += sampleSeconds;
      lowFpsSeconds = 0;
    } else {
      lowFpsSeconds = Math.max( 0, lowFpsSeconds - sampleSeconds );
      highFpsSeconds = 0;
    }

    if ( lowFpsSeconds > 4 && renderDpr > minDpr ) {
      renderDpr = Math.max( minDpr, renderDpr - 0.12 );
      lowFpsSeconds = 0;
      resize();
    } else if ( highFpsSeconds > 10 && renderDpr < Math.min( devicePixelRatio || 1, maxDpr ) ) {
      renderDpr = Math.min( Math.min( devicePixelRatio || 1, maxDpr ), renderDpr + 0.08 );
      highFpsSeconds = 0;
      resize();
    }
  }

  function animate( now ) {
    if ( paused ) return;

    const delta = Math.min( ( now - lastTime ) / 1000, 0.05 );
    lastTime = now;
    uTime.value += delta;
    sky.position.copy( camera.position );
    orbit.update( delta );
    signGroup.rotation.y = Math.sin( uTime.value * 0.17 ) * 0.012;
    signGroup.rotation.z = Math.sin( uTime.value * 0.11 ) * 0.0025;
    renderPipeline.render();
    cssRenderer.render( scene, camera );

    fpsFrames ++;
    const elapsed = ( now - fpsWindowStart ) / 1000;
    if ( elapsed >= 0.55 ) {
      const fps = fpsFrames / elapsed;
      fpsOutput.textContent = `${ Math.round( fps ) } FPS`;
      adaptResolution( fps, elapsed );
      fpsFrames = 0;
      fpsWindowStart = now;
    }
  }

  try {
    statusMessage.textContent = 'Compiling procedural sky and water…';
    await renderer.compileAsync( scene, camera );
    renderPipeline.render();
    await renderer.setAnimationLoop( animate );
  } catch ( error ) {
    resizeObserver.disconnect();
    renderer.dispose();
    showFailure( 'Shader compilation failed', 'This GPU could not compile the WebGPU ocean shaders. Update the browser or graphics driver and reload.' );
    return;
  }

  status.classList.add( 'is-hidden' );
  controlsPanel.classList.add( 'is-ready' );
}

start().catch( () => {
  showFailure( 'Unexpected startup error', 'The experience could not start. Reload the page in a current WebGPU-capable browser.' );
} );
