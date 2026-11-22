// Apoyos de decisión para la central y la cuadrilla durante la lluvia.
// Son funciones puras: las pruebas viven en decision.test.ts (`npm test`).
// Mantienen separados lo observado (fotos y reportes clasificados por Claude) y lo calculado
// (aportes de la fórmula v1). Nada de aquí cambia el puntaje: solo lo explica o lo ordena.
import type { ApiFicha } from "./api";
import type { Prioridad } from "./data";
import { NOMBRE_VARIABLE } from "./real.ts";

/** Lo mínimo de un pin para decidir qué se dibuja encima. */
export interface PinOrdenable {
  rank: number | string;
  prio: Prioridad | "anegado";
  faded?: boolean;
}

const PESO_PRIO: Record<PinOrdenable["prio"], number> = { baja: 0, media: 1, alta: 2, anegado: 3 };

/**
 * Orden de dibujo de los pines del mapa: el último queda encima. Primero los atenuados, después
 * de menor a mayor prioridad y, a igual prioridad, el puesto 1 al final. Así un punto alto nunca
 * queda tapado por uno bajo cuando se solapan.
 */
export function ordenPins(a: PinOrdenable, b: PinOrdenable): number {
  const atenuado = Number(!!b.faded) - Number(!!a.faded);
  if (atenuado) return atenuado;
  const prio = PESO_PRIO[a.prio] - PESO_PRIO[b.prio];
  if (prio) return prio;
  return typeof a.rank === "number" && typeof b.rank === "number" ? b.rank - a.rank : 0;
}

/** Las variables que más suman al puntaje calculado, con su nombre legible. */
export function motivosCalculados(aportes: Record<string, number> | null | undefined, max = 2): string[] {
  return Object.entries(aportes ?? {})
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => (NOMBRE_VARIABLE[k] ?? k).toLowerCase());
}

/** Vigencias de backend/config/formula.yaml: observado.vigencia_horas (también VIGENCIA_FOTO_H de
 * cadenas.ts) y durante.vigencia_agua_horas. El agua dura menos que una obstrucción. */
export const VIGENCIA_OBSERVACION_H = 72;
export const VIGENCIA_AGUA_H = 6;

export interface Evidencia {
  tipo: string;
  fuente: string;
  ts: string;
  rejilla: string | null;
  material: string[];
  nivelAgua: string | null;
  simulada: boolean;
}

type ObsFicha = ApiFicha["observaciones"][number];

/**
 * La observación evaluable más reciente que sigue vigente. Una imagen no evaluable no reemplaza a
 * la anterior: la anterior sigue mandando hasta que expira. `tipo` filtra por tipo de observación.
 */
export function evidenciaVigente(obs: readonly ObsFicha[], ahora = Date.now(), tipo?: string): Evidencia | null {
  const ordenadas = obs.filter((o) => !tipo || o.tipo === tipo).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  for (const o of ordenadas) {
    const t = Date.parse(o.ts);
    const c = (o.clasificacion ?? null) as Record<string, unknown> | null;
    if (!Number.isFinite(t) || !c || c.evaluable === false) continue;
    const nivelAgua = typeof c.nivel_agua === "string" ? c.nivel_agua : null;
    const vigenciaH = nivelAgua && typeof c.rejilla !== "string" ? VIGENCIA_AGUA_H : VIGENCIA_OBSERVACION_H;
    if (ahora - t >= vigenciaH * 3_600_000) continue;
    return {
      tipo: o.tipo,
      fuente: o.fuente,
      ts: o.ts,
      rejilla: typeof c.rejilla === "string" ? c.rejilla : null,
      material: Array.isArray(c.material) ? c.material.map(String) : [],
      nivelAgua,
      simulada: !!o.is_simulated,
    };
  }
  return null;
}

const FUENTE: Record<string, string> = { vecino: "Foto de vecino", cuadrilla: "Foto de cuadrilla", camara: "Cámara", sensor: "Sensor" };
const REJILLA: Record<string, string> = { tapada: "rejilla tapada", parcial: "rejilla parcialmente tapada", limpia: "rejilla limpia" };
const AGUA: Record<string, string> = { cuneta: "agua en la cuneta", hasta_vereda: "agua hasta la vereda", sobre_vereda: "agua sobre la vereda" };

/** "Foto de vecino: rejilla tapada (hojas, sedimento)". La hora va aparte, en hora de Santiago. */
export function textoEvidencia(e: Evidencia): string {
  const origen = e.tipo === "texto" ? "Reporte de texto" : (FUENTE[e.fuente] ?? "Reporte");
  const que = (e.rejilla && REJILLA[e.rejilla]) || (e.nivelAgua && AGUA[e.nivelAgua]) || "clasificación registrada";
  return `${origen}: ${que}${e.material.length ? ` (${e.material.join(", ")})` : ""}`;
}

/**
 * Qué llevar según la última foto, con la misma regla del despacho (backend/app/services/dispatch.py):
 * sedimento en una foto de rejilla pide hidrojet; hojas o basura se sacan con herramientas manuales.
 */
export function equipoSugerido(e: Evidencia | null): "hidrojet" | "manual" | null {
  if (!e || e.tipo !== "foto_rejilla" || !e.material.length) return null;
  if (e.material.includes("sedimento")) return "hidrojet";
  return "manual";
}

export interface ParadaEnRuta {
  orden: number;
  estado: string;
}

/** Posición de cada rejilla en la ruta de una cuadrilla (1 = siguiente parada). */
export function paradasPorSumidero(misiones: readonly { sumidero_id: string | null; estado: string }[]): Map<string, ParadaEnRuta> {
  const m = new Map<string, ParadaEnRuta>();
  misiones.forEach((x, i) => {
    if (x.sumidero_id && !m.has(x.sumidero_id)) m.set(x.sumidero_id, { orden: i + 1, estado: x.estado });
  });
  return m;
}
