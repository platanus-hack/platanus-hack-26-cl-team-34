// Carga MapLibre GL desde CDN (sin dependencia npm).
const VERSION = "4.7.1";
const JS = `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.js`;
const CSS = `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.css`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MapLibre = any;

let promise: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.maplibregl) return Promise.resolve(w.maplibregl);
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = JS;
    s.async = true;
    s.onload = () => (w.maplibregl ? resolve(w.maplibregl) : reject(new Error("maplibregl no disponible")));
    s.onerror = () => {
      promise = null;
      reject(new Error("No se pudo cargar MapLibre"));
    };
    document.head.appendChild(s);
  });
  return promise;
}

// Mapa base: Esri Canvas, World Light Gray y World Dark Gray (Esri, HERE, Garmin, © OpenStreetMap).
// Las dos variantes están en el estilo y `pintarMapa` (DrenaMap) deja visible la que calza con el
// fondo de la paleta: con fondo oscuro, la gris oscura. MapLibre solo pide teselas de capas visibles.
const esri = (servicio: string) => ({
  type: "raster",
  tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${servicio}/MapServer/tile/{z}/{y}/{x}`],
  tileSize: 256,
  maxzoom: 16,
});

/** Capas raster de cada variante del mapa base. */
export const CAPAS_BASE = { claro: ["base", "ref"], oscuro: ["base-osc", "ref-osc"] } as const;

const oculta = { visibility: "none" };

/** Opacidad normal de los nombres del mapa base (DrenaMap la baja cuando muestra los nombres de comuna). */
export const OPACIDAD_NOMBRES = { ref: 0.75, "ref-osc": 0.7 } as const;

export const BASE_STYLE = {
  version: 8,
  sources: {
    base: esri("World_Light_Gray_Base"),
    ref: esri("World_Light_Gray_Reference"),
    "base-osc": esri("World_Dark_Gray_Base"),
    "ref-osc": esri("World_Dark_Gray_Reference"),
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#2d2c33" } }, // paleta-ok: valor inicial; pintarMapa lo repinta con --map-bg
    // Primero los dos fondos y después las dos capas de nombres: el relieve se inserta antes de "ref"
    // y así queda sobre el fondo de cualquiera de las dos variantes y bajo sus nombres.
    { id: "base", type: "raster", source: "base", layout: oculta, paint: { "raster-saturation": -1, "raster-opacity": 0.95 } },
    // Sin color propio y algo transparente: el fondo de la paleta (--map-bg) tiñe las calles y manzanas
    { id: "base-osc", type: "raster", source: "base-osc", paint: { "raster-saturation": -1, "raster-opacity": 0.8, "raster-contrast": 0.15 } },
    { id: "ref", type: "raster", source: "ref", layout: oculta, paint: { "raster-opacity": OPACIDAD_NOMBRES.ref } },
    { id: "ref-osc", type: "raster", source: "ref-osc", paint: { "raster-saturation": -1, "raster-opacity": OPACIDAD_NOMBRES["ref-osc"] } },
  ],
};
