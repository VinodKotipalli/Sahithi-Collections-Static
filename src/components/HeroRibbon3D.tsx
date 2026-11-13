import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

function detectSoftwareWebGL(): boolean {
  if (typeof document === 'undefined') return true;
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const rendererString = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(rendererString);
  } catch {
    return true;
  }
}

function createSilkRibbonGeometry(
  radiusX: number,
  radiusY: number,
  depthAmp: number,
  ribbonWidth: number,
  segments = 160
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const curvePoints: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const x = Math.sin(t) * radiusX + Math.sin(2 * t) * 0.28;
    const y = Math.cos(t) * radiusY + Math.sin(3 * t) * 0.14;
    const z = Math.sin(2 * t) * depthAmp;
    curvePoints.push(new THREE.Vector3(x, y, z));
  }

  const curve = new THREE.CatmullRomCurve3(curvePoints, true, 'catmullrom', 0.5);
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const point = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u).normalize();

    // Gently twist the ribbon normal along the curve so light sweeps silkily across folds
    const twistAngle = u * Math.PI * 2;
    const binormal = new THREE.Vector3().crossVectors(tangent, up).normalize();
    if (binormal.lengthSq() < 0.001) {
      binormal.set(1, 0, 0);
    }
    const normal = new THREE.Vector3().crossVectors(binormal, tangent).normalize();
    binormal.applyAxisAngle(tangent, twistAngle * 0.5);
    normal.applyAxisAngle(tangent, twistAngle * 0.5);

    const halfWidth = ribbonWidth * (0.78 + 0.22 * Math.sin(u * Math.PI * 4));
    const pLeft = point.clone().addScaledVector(binormal, -halfWidth);
    const pRight = point.clone().addScaledVector(binormal, halfWidth);

    positions.push(pLeft.x, pLeft.y, pLeft.z);
    positions.push(pRight.x, pRight.y, pRight.z);

    normals.push(normal.x, normal.y, normal.z);
    normals.push(normal.x, normal.y, normal.z);

    uvs.push(u, 0);
    uvs.push(u, 1);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function StudioEnvironment() {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmremGenerator = new THREE.PMREMGenerator(gl);
    const envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmremGenerator.dispose();

    return () => {
      scene.environment = null;
      envTarget.dispose();
    };
  }, [gl, scene]);

  return null;
}

interface SculpturalMobileProps {
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
  allowPointerInteraction: boolean;
}

function SculpturalSilkMobile({ pointerRef, allowPointerInteraction }: SculpturalMobileProps) {
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const pearlOrbitRef = useRef<THREE.Group>(null);

  const primaryRibbonGeo = useMemo(
    () => createSilkRibbonGeometry(1.38, 1.08, 0.52, 0.22, 168),
    []
  );
  const secondaryRibbonGeo = useMemo(
    () => createSilkRibbonGeometry(1.06, 0.84, -0.38, 0.11, 128),
    []
  );
  const haloGeo = useMemo(() => new THREE.TorusGeometry(1.62, 0.016, 16, 120), []);
  const pearlGeo = useMemo(() => new THREE.SphereGeometry(0.085, 24, 24), []);

  const silkMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#E8BAC6'),
        roughness: 0.26,
        metalness: 0.28,
        clearcoat: 0.72,
        clearcoatRoughness: 0.18,
        sheen: 1.0,
        sheenRoughness: 0.35,
        sheenColor: new THREE.Color('#FFF4F7'),
        iridescence: 0.55,
        iridescenceIOR: 1.35,
        side: THREE.DoubleSide,
      }),
    []
  );

  const roseGoldMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#D39C9F'),
        roughness: 0.2,
        metalness: 0.9,
        clearcoat: 0.45,
        side: THREE.DoubleSide,
      }),
    []
  );

  const pearlMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#FFF9F5'),
        roughness: 0.12,
        metalness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        iridescence: 0.75,
        iridescenceIOR: 1.4,
      }),
    []
  );

  useEffect(() => {
    return () => {
      primaryRibbonGeo.dispose();
      secondaryRibbonGeo.dispose();
      haloGeo.dispose();
      pearlGeo.dispose();
      silkMaterial.dispose();
      roseGoldMaterial.dispose();
      pearlMaterial.dispose();
    };
  }, [
    primaryRibbonGeo,
    secondaryRibbonGeo,
    haloGeo,
    pearlGeo,
    silkMaterial,
    roseGoldMaterial,
    pearlMaterial,
  ]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.getElapsedTime();

    if (groupRef.current) {
      const targetRotY =
        Math.sin(t * 0.28) * 0.24 + (allowPointerInteraction ? pointerRef.current.x * 0.26 : 0);
      const targetRotX =
        Math.cos(t * 0.22) * 0.12 + (allowPointerInteraction ? -pointerRef.current.y * 0.18 : 0);

      groupRef.current.rotation.y = THREE.MathUtils.damp(
        groupRef.current.rotation.y,
        targetRotY,
        3.2,
        dt
      );
      groupRef.current.rotation.x = THREE.MathUtils.damp(
        groupRef.current.rotation.x,
        targetRotX,
        3.2,
        dt
      );
      groupRef.current.position.y = Math.sin(t * 0.55) * 0.07;
    }

    if (haloRef.current) {
      haloRef.current.rotation.z = t * 0.08;
    }

    if (pearlOrbitRef.current) {
      pearlOrbitRef.current.rotation.y = -t * 0.16;
    }
  });

  return (
    <group ref={groupRef} rotation={[0.18, -0.25, 0.1]}>
      <mesh geometry={primaryRibbonGeo} material={silkMaterial} />
      <mesh
        geometry={secondaryRibbonGeo}
        material={roseGoldMaterial}
        rotation={[0.38, 0.55, -0.2]}
      />
      <mesh
        ref={haloRef}
        geometry={haloGeo}
        material={roseGoldMaterial}
        rotation={[Math.PI * 0.34, 0.22, 0]}
      />
      <group ref={pearlOrbitRef}>
        <mesh geometry={pearlGeo} material={pearlMaterial} position={[1.45, 0.55, 0.35]} scale={1.05} />
        <mesh geometry={pearlGeo} material={pearlMaterial} position={[-1.35, -0.45, 0.48]} scale={0.82} />
        <mesh geometry={pearlGeo} material={pearlMaterial} position={[0.25, -1.25, -0.45]} scale={0.68} />
        <mesh geometry={pearlGeo} material={pearlMaterial} position={[-0.45, 1.18, -0.32]} scale={0.75} />
      </group>
    </group>
  );
}

export default function HeroRibbon3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [isSoftwareGl] = useState(() => detectSoftwareWebGL());
  const [isVisible, setIsVisible] = useState(true);
  const [isTabActive, setIsTabActive] = useState(
    typeof document !== 'undefined' ? !document.hidden : true
  );
  const [allowPointerInteraction] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(pointer: fine)').matches;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]) {
          setIsVisible(entries[0].isIntersecting);
        }
      },
      { threshold: 0.05 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      setIsTabActive(!document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!allowPointerInteraction) return;
    const onPointerMove = (event: PointerEvent) => {
      const nx = (event.clientX / window.innerWidth) * 2 - 1;
      const ny = (event.clientY / window.innerHeight) * 2 - 1;
      pointerRef.current.x = THREE.MathUtils.clamp(nx, -1, 1);
      pointerRef.current.y = THREE.MathUtils.clamp(ny, -1, 1);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [allowPointerInteraction]);

  const isActive = isVisible && isTabActive;

  return (
    <div ref={containerRef} aria-hidden="true" className="h-full w-full pointer-events-none">
      <Canvas
        frameloop={isActive ? 'always' : 'demand'}
        dpr={isSoftwareGl ? 1 : [1, 1.5]}
        camera={{ position: [0, 0, 4.9], fov: 38 }}
        gl={{
          antialias: !isSoftwareGl,
          alpha: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.08,
        }}
        style={{ background: 'transparent' }}
      >
        <StudioEnvironment />
        <directionalLight position={[4, 5, 4]} intensity={1.7} color="#FFF3EA" />
        <hemisphereLight args={['#FBE9EF', '#49243E', 0.9]} />
        <pointLight position={[-3.5, -2, 2.5]} intensity={1.1} color="#F3D5DF" />
        <SculpturalSilkMobile
          pointerRef={pointerRef}
          allowPointerInteraction={allowPointerInteraction}
        />
      </Canvas>
    </div>
  );
}
