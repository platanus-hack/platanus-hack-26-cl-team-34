"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LngLat, Prioridad } from "@/lib/data";
import { FLUJO_CONFIG } from "@/lib/flujo/config";
import { BASE_STYLE, loadMapLibre, type MapLibre } from "./maplibre";
import { colorDe, EVENTO_PALETA } from "@/lib/paleta";
import { ordenPins } from "@/lib/decision";

export interface MapPin {
  id: string;
  coord: LngLat;
  rank: number | string;
  prio: Prioridad | "anegado";
  faded?: boolean;
  ring?: "flood"; // Durante: ondas del punto anegado
  onClick?: () => void;
}

export interface MapLabel {
  coord: LngLat;
  text: string;
  sub?: string;
  tone: "card" | "pill" | "danger" | "dark" | "area";
  offset?: [number, number];
  anchor?: "left" | "right" | "top" | "bottom" | "center" | "top-left" | "bottom-left";
}

export interface MapParadero {
  id: string;
  coord: LngLat;
  nivel: "expuesto" | "en_riesgo" | "alternativo";
  activo?: boolean;
  titulo: string;
  onClick?: () => void;
}

export interface DrenaMapProps {
  pins?: MapPin[];
  labels?: MapLabel[];
  lines?: LngLat[][];
  limites?: LngLat[][] | null;
  area?: LngLat[] | null;
  gore?: LngLat[] | null;
  comunas?: boolean; // límites de todas las comunas de la RM con su nombre (public/data/comunas_rm.geojson). Por defecto, sí
  rejillas?: boolean; // catastro de rejillas MOP, en gris y solo de cerca (public/data/rejillas.geojson)
  /** Relieve (sombreado del terreno) y, si `tresD`, terreno 3D con edificios. Sin clave: AWS Terrain Tiles y OpenFreeMap. */
  relieve?: boolean;
  tresD?: boolean;
  chain?: LngLat[] | null; // Durante: cadena aguas abajo del punto anegado
  celda?: { poly: LngLat[]; rayos: LngLat[]; link: [LngLat, LngLat] } | null; // Durante: celda convectiva ilustrativa
  paraderos?: MapParadero[] | null; // transporte: expuestos, en riesgo y alternativos (#92)
  recorridos?: LngLat[][] | null; // trazado de los servicios afectados
  caminatas?: [LngLat, LngLat][] | null; // paradero expuesto → paradero alternativo
  bounds: [LngLat, LngLat];
  padding?: number | { top: number; bottom: number; left: number; right: number };
  attribution?: string;
  attributionSide?: "left" | "right";
  className?: string;
  children?: ReactNode;
  pinSize?: number;
  /** Se llama una vez cuando el mapa y sus capas base están listos; puede devolver una función de limpieza. */
  onMapReady?: (map: MapLibre, ml: MapLibre) => void | (() => void);
}

const TRIANGULO = "M20 3 L37.5 34 L2.5 34 Z"; // ▲ prioridad alta
const COLORS: Record<string, string> = {
  alta: "var(--prio-alta)",
  media: "var(--prio-media)",
  baja: "var(--prio-baja)",
  anegado: "var(--danger)",
};

function pinEl(p: MapPin, size: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pin" + (p.faded ? " pin--faded" : "") + (p.onClick ? " pin--click" : "") + (p.prio === "alta" ? " pin--tri" : "") + ` pin--${p.prio}`;
  el.style.width = el.style.height = `${size}px`;
  const fill = COLORS[p.prio];
  let shape = "";
  if (p.prio === "alta") shape = `<path d="${TRIANGULO}" fill="${fill}" stroke="var(--fondo)" stroke-width="3" stroke-linejoin="round"/>`;
  else if (p.prio === "media")
    shape = `<rect x="7" y="7" width="26" height="26" rx="4" transform="rotate(45 20 20)" fill="${fill}" stroke="var(--fondo)" stroke-width="3"/>`;
  else shape = `<circle cx="20" cy="20" r="17" fill="${fill}" stroke="var(--fondo)" stroke-width="3"/>`;
  const txt = p.prio === "anegado" ? "≋" : String(p.rank);
  el.innerHTML = `<svg viewBox="0 0 40 40" width="${size}" height="${size}">${shape}</svg><span class="pin__n">${txt}</span>`;
  if (p.ring === "flood") {
    el.insertAdjacentHTML("afterbegin", `<span class="pin__flood pin__flood--1"></span><span class="pin__flood pin__flood--2"></span><span class="pin__flood pin__flood--3"></span>`);
  }
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      p.onClick!();
    });
  }
  return el;
}

const PARADERO_SIGNO = { expuesto: "≋", en_riesgo: "!", alternativo: "↪" } as const;

function paraderoEl(p: MapParadero): HTMLElement {
  const el = document.createElement("div");
  el.className = `paradero paradero--${p.nivel}` + (p.activo ? " is-active" : "") + (p.onClick ? " pin--click" : "");
  el.title = p.titulo;
  el.setAttribute("aria-label", p.titulo);
  el.innerHTML = `<span class="paradero__bus">BUS</span><span class="paradero__signo">${PARADERO_SIGNO[p.nivel]}</span>`;
  if (p.onClick) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      p.onClick!();
    });
  }
  return el;
}

function labelEl(l: MapLabel): HTMLElement {
  const el = document.createElement("div");
  el.className = `map-label map-label--${l.tone}`;
  el.textContent = l.text;
  if (l.sub) {
    const s = document.createElement("span");
    s.className = "map-label__sub";
    s.textContent = l.sub;
    el.appendChild(s);
  }
  return el;
}

// Colores de los tokens de globals.css. MapLibre no lee variables CSS: se resuelven al crear el mapa y cada vez
// que cambia el esquema de color, así las capas siguen al tema (claro u oscuro) sin repetir los hex aquí.
// Colores de las capas propias, desde la paleta (lib/paleta.json). MapLibre no lee variables CSS:
// se leen con colorDe() al crear el mapa, al cambiar la paleta (EVENTO_PALETA) o el tema del sistema.
const COLORES_CAPAS: [capa: string, propiedad: string, color: string][] = [
  ["bg", "background-color", "map-bg"],
  ["relieve", "hillshade-shadow-color", "text-2"],
  ["relieve", "hillshade-highlight-color", "surface"],
  ["relieve", "hillshade-accent-color", "contexto"],
  ["edificios", "fill-extrusion-color", "surface-2"],
  ["area-fill", "fill-color", "agua"],
  ["area-line", "line-color", "agua"],
  ["celda-fill", "fill-color", "secundario"],
  ["celda-line", "line-color", "secundario"],
  ["celda-link", "line-color", "secundario"],
  ["lim", "line-color", "text-2"],
  ["rm-fill", "fill-color", "text-3"],
  ["rm-line", "line-color", "text-3"],
  ["rm-line-proy", "line-color", "text-3"],
  ["rej-cluster", "circle-color", "contexto"],
  ["rej-cluster", "circle-stroke-color", "contexto"],
  ["rej-point", "circle-color", "contexto"],
  ["rej-point", "circle-stroke-color", "surface"],
  ["esc-halo", "line-color", "agua"],
  ["esc-line", "line-color", "agua"],
  ["gore", "circle-color", "contexto"],
  ["gore", "circle-stroke-color", "surface"],
  ["rec-line", "line-color", "bus"],
  ["caminata", "line-color", "bus"],
  ["chain-halo", "line-color", "principal"],
  ["chain-line", "line-color", "principal"],
];

function pintarMapa(map: MapLibre) {
  for (const [capa, prop, color] of COLORES_CAPAS) if (map.getLayer(capa)) map.setPaintProperty(capa, prop, colorDe(color));
}

interface ComunaRm {
  comuna: string;
  enProyecto: boolean;
  coord: LngLat;
}
let comunasRmPromise: Promise<ComunaRm[]> | null = null;
function cargarComunasRm(): Promise<ComunaRm[]> {
  comunasRmPromise ??= fetch("/data/comunas_rm.geojson")
    .then((r) => r.json())
    .then((g: { features: { properties: { comuna: string; en_proyecto: boolean; lon: number; lat: number } }[] }) =>
      g.features.map((f) => ({ comuna: f.properties.comuna, enProyecto: f.properties.en_proyecto, coord: [f.properties.lon, f.properties.lat] as LngLat })),
    )
    .catch(() => {
      comunasRmPromise = null;
      return [];
    });
  return comunasRmPromise;
}

// Las etiquetas de comuna aparecen desde este zoom
export const ZOOM_ETIQUETAS_COMUNA = 11;

const fc = (features: unknown[]) => ({ type: "FeatureCollection", features });
const line = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } });
const poly = (c: LngLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...c, c[0]]] } });

export default function DrenaMap(props: DrenaMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre>(null);
  const libRef = useRef<MapLibre>(null);
  const markers = useRef<MapLibre[]>([]);
  const comunaMarkers = useRef<{ el: HTMLElement; marker: MapLibre }[]>([]);
  const unsubTema = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const size = props.pinSize ?? 40;

  // Capas extra de quien usa el mapa (p. ej. la simulación del flujo o las cadenas de la central). Va antes de crear el mapa: así su limpieza corre antes de map.remove()
  const onMapReadyRef = useRef(props.onMapReady);
  onMapReadyRef.current = props.onMapReady;
  useEffect(() => {
    if (!ready) return;
    return onMapReadyRef.current?.(mapRef.current, libRef.current) || undefined;
  }, [ready]);

  // Crear mapa
  useEffect(() => {
    let cancelled = false;
    loadMapLibre()
      .then((ml) => {
        if (cancelled || !ref.current) return;
        libRef.current = ml;
        const map = new ml.Map({
          container: ref.current,
          style: BASE_STYLE,
          bounds: props.bounds,
          fitBoundsOptions: { padding: props.padding ?? 40 },
          attributionControl: false,
          dragRotate: !!props.relieve, // en 3D se puede girar e inclinar con el botón derecho
          pitchWithRotate: !!props.relieve,
          maxPitch: 70,
        });
        if (!props.relieve) map.touchZoomRotate.disableRotation();
        mapRef.current = map;
        map.once("style.load", () => {
          const add = (id: string) => map.addSource(id, { type: "geojson", data: fc([]) });
          ["esc", "chain", "lim", "area", "celda", "celda-link", "gore", "rec", "caminata"].forEach(add);
          map.addSource("comunas-rm", { type: "geojson", data: "/data/comunas_rm.geojson" });
          map.addSource("rejillas", { type: "geojson", data: "/data/rejillas.geojson", cluster: true, clusterMaxZoom: 16, clusterRadius: 30 });
          if (props.relieve) {
            const ter = FLUJO_CONFIG.terreno;
            // Dos fuentes del mismo DEM: una para el terreno 3D y otra para el sombreado (MapLibre recomienda separarlas)
            const dem = { type: "raster-dem", tiles: [ter.tiles], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: "Terrain Tiles (AWS)" };
            map.addSource("dem-terreno", dem);
            map.addSource("dem-sombra", dem);
            map.addLayer(
              {
                id: "relieve",
                type: "hillshade",
                source: "dem-sombra",
                paint: { "hillshade-exaggeration": 0.35 },
              },
              "ref",
            );
            map.addSource("ofm", { type: "vector", url: FLUJO_CONFIG.edificios });
            map.addLayer({
              id: "edificios",
              type: "fill-extrusion",
              source: "ofm",
              "source-layer": "building",
              minzoom: 14,
              layout: { visibility: "none" },
              filter: ["!=", ["get", "hide_3d"], true],
              paint: {
                "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
                "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                "fill-extrusion-opacity": 0.55,
              },
            });
          }
          map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-opacity": 0.12 } });
          map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-width": 2, "line-opacity": 0.8 } });
          // Durante: celda convectiva ilustrativa (gris oscuro, no es agua ni alerta)
          map.addLayer({ id: "celda-fill", type: "fill", source: "celda", paint: { "fill-opacity": 0.14 } });
          map.addLayer({ id: "celda-line", type: "line", source: "celda", paint: { "line-width": 2, "line-dasharray": [3, 2] } });
          map.addLayer({ id: "celda-link", type: "line", source: "celda-link", paint: { "line-width": 3, "line-opacity": 0.8, "line-dasharray": [1.5, 1.5] } });
          map.addLayer({ id: "lim", type: "line", source: "lim", paint: { "line-width": 2, "line-opacity": 0.8, "line-dasharray": [4, 3] } });
          const hidden = { visibility: "none" };
          // Límites de todas las comunas: línea fina punteada en --text-3, relleno casi invisible; las 3 del proyecto, algo más marcadas.
          map.addLayer({ id: "rm-fill", type: "fill", source: "comunas-rm", paint: { "fill-opacity": 0.035 } });
          map.addLayer({ id: "rm-line", type: "line", source: "comunas-rm", paint: { "line-width": 0.9, "line-opacity": 0.85, "line-dasharray": [2, 2] } });
          map.addLayer({
            id: "rm-line-proy",
            type: "line",
            source: "comunas-rm",
            filter: ["==", ["get", "en_proyecto"], true],
            paint: { "line-width": 1.8, "line-opacity": 1, "line-dasharray": [3, 2] },
          });
          // Capas de contexto (catastro completo y GORE): pequeñas, en gris y solo de cerca, para no competir con el agua
          const zc = FLUJO_CONFIG.zoomContexto;
          map.addLayer({
            id: "rej-cluster",
            type: "circle",
            source: "rejillas",
            minzoom: zc,
            filter: ["has", "point_count"],
            layout: hidden,
            paint: { "circle-opacity": 0.18, "circle-stroke-width": 1, "circle-radius": ["step", ["get", "point_count"], 6, 10, 8, 50, 10] },
          });
          map.addLayer({
            id: "rej-point",
            type: "circle",
            source: "rejillas",
            minzoom: zc,
            filter: ["!", ["has", "point_count"]],
            layout: hidden,
            paint: { "circle-radius": 2, "circle-stroke-width": 0.5 },
          });
          // Líneas de escurrimiento de ejemplo (ficha y móvil): agua, en azul
          map.addLayer({ id: "esc-halo", type: "line", source: "esc", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 8, "line-opacity": 0.12 } });
          map.addLayer({ id: "esc-line", type: "line", source: "esc", layout: { "line-cap": "round" }, paint: { "line-width": 2, "line-opacity": 0.8 } });
          map.addLayer({ id: "gore", type: "circle", source: "gore", minzoom: zc, paint: { "circle-radius": 2.5, "circle-stroke-width": 0.75 } });
          // Durante: cadena aguas abajo del punto anegado en accent (alerta).
          // Transporte: azul fuera de la paleta de prioridad para no confundir un recorrido con escurrimiento.
          map.addLayer({ id: "rec-line", type: "line", source: "rec", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 3, "line-opacity": 0.55 } });
          map.addLayer({ id: "caminata", type: "line", source: "caminata", layout: { "line-cap": "round" }, paint: { "line-width": 2.5, "line-dasharray": [0.5, 2] } });
          map.addLayer({ id: "chain-halo", type: "line", source: "chain", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 14, "line-opacity": 0.2 } });
          map.addLayer({ id: "chain-line", type: "line", source: "chain", paint: { "line-width": 3, "line-dasharray": [1.5, 1.5] } });
          pintarMapa(map);
          // Si cambia el esquema de color del sistema, se vuelven a leer los colores
          const repintar = () => pintarMapa(map);
          const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
          mq?.addEventListener?.("change", repintar);
          unsubTema.current = () => mq?.removeEventListener?.("change", repintar);
          setReady(true);
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      unsubTema.current();
      comunaMarkers.current.forEach((c) => c.marker.remove());
      comunaMarkers.current = [];
      markers.current.forEach((m) => m.remove());
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Terreno 3D y edificios. Va ANTES del encuadre: cambiar el terreno en medio de una animación de cámara congela el
  // render de MapLibre, así que primero se detiene la cámara, se aplica el terreno y después se mueve.
  useEffect(() => {
    if (!ready || !props.relieve) return;
    const map = mapRef.current;
    map.stop();
    map.setTerrain(props.tresD ? { source: "dem-terreno", exaggeration: FLUJO_CONFIG.terreno.exageracion } : null);
    if (map.getLayer("edificios")) map.setLayoutProperty("edificios", "visibility", props.tresD ? "visible" : "none");
  }, [ready, props.relieve, props.tresD]);

  // Paleta editable (#131): repinta las capas sin recrear el mapa
  useEffect(() => {
    if (!ready) return;
    const repintar = () => mapRef.current && pintarMapa(mapRef.current);
    window.addEventListener(EVENTO_PALETA, repintar);
    return () => window.removeEventListener(EVENTO_PALETA, repintar);
  }, [ready]);

  // Encuadre (en 3D, con la inclinación y el rumbo de la vista)
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const ter = FLUJO_CONFIG.terreno;
    const bearing = props.tresD ? ter.bearing : 0;
    const cam = map.cameraForBounds(props.bounds, { padding: props.padding ?? 40, bearing });
    if (cam) map.easeTo({ ...cam, bearing, pitch: props.tresD ? ter.pitch : 0, duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(props.bounds), props.tresD]);

  // Capas vectoriales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const set = (id: string, data: unknown) => map.getSource(id)?.setData(data);
    set("esc", fc((props.lines ?? []).map(line)));
    set("lim", fc((props.limites ?? []).map(line)));
    set("area", fc(props.area ? [poly(props.area)] : []));
    set("chain", fc(props.chain ? [line(props.chain)] : []));
    set("celda", fc(props.celda ? [poly(props.celda.poly)] : []));
    set("celda-link", fc(props.celda ? [line(props.celda.link)] : []));
    set("rec", fc((props.recorridos ?? []).map(line)));
    set("caminata", fc((props.caminatas ?? []).map(line)));
    set("gore", fc((props.gore ?? []).map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }))));
  }, [ready, props.lines, props.chain, props.limites, props.area, props.celda, props.gore, props.recorridos, props.caminatas]);

  // Visibilidad de las capas de datos reales
  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const vis = (ids: string[], on?: boolean) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    vis(["rm-fill", "rm-line", "rm-line-proy"], props.comunas ?? true);
    vis(["rej-cluster", "rej-point"], props.rejillas);
  }, [ready, props.comunas, props.rejillas]);

  // Nombres de comuna: HTML en Geist Mono (el estilo base no tiene glifos para una capa de texto). Visibles desde el zoom 11.
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    let vivo = true;
    const actualizar = () => {
      const z = map.getZoom();
      const on = (props.comunas ?? true) && z >= ZOOM_ETIQUETAS_COMUNA;
      comunaMarkers.current.forEach(({ el }) => el.classList.toggle("is-on", on));
      // Con los nombres de comuna a la vista, los del mapa base se atenúan para no pisarse
      map.setPaintProperty("ref", "raster-opacity", on ? (z >= 15 ? 0.75 : 0.08) : 0.75);
    };
    cargarComunasRm().then((lista) => {
      if (!vivo) return;
      comunaMarkers.current.forEach((c) => c.marker.remove());
      comunaMarkers.current = lista.map((c) => {
        const el = document.createElement("div");
        el.className = `comuna-label${c.enProyecto ? " comuna-label--proy" : ""}`;
        el.textContent = c.comuna;
        const marker = new ml.Marker({ element: el, anchor: "center" }).setLngLat(c.coord).addTo(map);
        return { el, marker };
      });
      actualizar();
    });
    map.on("zoom", actualizar);
    actualizar();
    return () => {
      vivo = false;
      map.off("zoom", actualizar);
    };
  }, [ready, props.comunas]);

  // Marcadores HTML
  useEffect(() => {
    if (!ready) return;
    const ml = libRef.current;
    const map = mapRef.current;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const add = (el: HTMLElement, coord: LngLat, anchor = "center", offset: [number, number] = [0, 0]) => {
      markers.current.push(new ml.Marker({ element: el, anchor, offset }).setLngLat(coord).addTo(map));
    };
    (props.celda?.rayos ?? []).forEach((c) => {
      const el = document.createElement("div");
      el.className = "rayo";
      el.textContent = "ϟ";
      add(el, c);
    });
    // Paraderos bajo los pines de prioridad; el activo al final para que quede encima
    [...(props.paraderos ?? [])].sort((a, b) => Number(!!a.activo) - Number(!!b.activo)).forEach((p) => add(paraderoEl(p), p.coord));
    // Pins: el último agregado queda encima. Primero los atenuados y después de menor a mayor
    // prioridad, así un punto alto nunca queda tapado por uno bajo cuando se solapan.
    [...(props.pins ?? [])].sort(ordenPins).forEach((p) => add(pinEl(p, size), p.coord));
    (props.labels ?? []).forEach((l) => add(labelEl(l), l.coord, l.anchor ?? "left", l.offset ?? [size / 2 + 6, 0]));
  }, [ready, props.pins, props.labels, props.celda, props.paraderos, size]);

  return (
    <div className={`map ${props.className ?? ""}`}>
      <div ref={ref} className="map__canvas" />
      {failed && <div className="map__fallback">Mapa no disponible sin conexión</div>}
      {props.children}
      {props.attribution && <div className={`map__attr map__attr--${props.attributionSide ?? "left"}`}>{props.attribution}</div>}
    </div>
  );
}
