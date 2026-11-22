// Cliente del backend. Usa NEXT_PUBLIC_API_URL (la misma que lib/store.tsx).
// Render (plan gratuito) tarda ~50 s en despertar: timeout largo, reintento y aviso "despertando".

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    msg: string,
    readonly estado?: number,
  ) {
    super(msg);
  }
}

export interface GetOpts {
  timeoutMs?: number;
  reintentos?: number;
  cache?: RequestCache;
  /** Se llama una vez si la respuesta tarda más de `lentoMs`: el servidor probablemente está despertando. */
  onLento?: () => void;
  lentoMs?: number;
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function apiGet<T>(ruta: string, o: GetOpts = {}): Promise<T> {
  const { timeoutMs = 70_000, reintentos = 2, cache, onLento, lentoMs = 5_000 } = o;
  let ultimo: unknown;
  const aviso = onLento ? setTimeout(onLento, lentoMs) : null;
  try {
    for (let i = 0; i <= reintentos; i++) {
      try {
        const r = await fetch(`${API_URL}${ruta}`, { cache, signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return (await r.json()) as T;
        // 4xx (salvo 408/429) no mejora reintentando
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new ApiError(`El servidor respondió ${r.status}`, r.status);
        ultimo = new ApiError(`El servidor respondió ${r.status}`, r.status);
      } catch (e) {
        if (e instanceof ApiError && e.estado && e.estado < 500 && e.estado !== 408 && e.estado !== 429) throw e;
        ultimo = e;
      }
      if (i < reintentos) await espera(1500 * (i + 1));
    }
  } finally {
    if (aviso) clearTimeout(aviso);
  }
  throw ultimo instanceof Error ? ultimo : new ApiError("No se pudo conectar con el servidor");
}

// --- Contrato real (backend/app/routers/{scenarios,sumideros}.py) ---

export interface ApiEscenario {
  id: string;
  nombre: string;
  descripcion: string | null;
  parametros: Record<string, unknown>;
}

export interface ApiDetalle {
  p?: number;
  urgente?: boolean;
  aportes?: Record<string, number>;
  fuente_p?: string;
  area_norm?: number;
  criticidad?: number;
  area_faltante?: boolean;
  // Confianza de Claude y el factor que aplicó la fórmula (#88, #124)
  confianza_foto?: ApiConfianza | null;
  factor_confianza_foto?: number;
  factores_confianza_texto?: number[];
  nivel_agua?: string;
  confianza_agua?: ApiConfianza | null;
  factor_confianza_agua?: number;
  [k: string]: unknown;
}

export type ApiConfianza = "alta" | "media" | "baja";

/** Señal vigente que entra al cálculo de un sumidero (GET /sumideros/{id}, #124). */
export interface ApiSenal {
  observation_id: string;
  senal: "rejilla" | "texto" | "agua";
  fuente: string;
  tipo_observacion: string;
  /** Hora de captura, UTC. */
  ts: string;
  /** Lo que leyó Claude: estado de la rejilla, tipo de texto o nivel de agua. */
  valor: string;
  /** null: la clasificación no trae confianza (textos, clasificaciones antiguas). */
  confianza: ApiConfianza | null;
  factor_confianza: number;
  aplica_en: ("antes" | "durante")[];
  /** Si la fórmula la toma hoy. */
  usada: boolean;
  is_simulated: boolean;
}

export interface ApiRankingItem {
  rank: number;
  sumidero_id: string;
  p_pred: number | null;
  p_obs: number | null;
  p_ef: number | null;
  c: number | null;
  prioridad: number | null;
  explicacion: string | null;
  detalle: ApiDetalle | null;
  computed_at: string | null;
  intersection_id: string | null;
  intersection_nombre: string | null;
  street_id: string | null;
  is_simulated: boolean;
  lat: number;
  lon: number;
}

export interface ApiRanking {
  scenario_id: string;
  modo: "antes" | "durante";
  items: ApiRankingItem[];
}

export interface ApiScore {
  modo: "antes" | "durante";
  rank: number;
  p_pred: number | null;
  p_obs: number | null;
  p_ef: number | null;
  c: number | null;
  prioridad: number | null;
  explicacion: string | null;
  detalle: ApiDetalle | null;
  computed_at: string | null;
}

export interface ApiFicha {
  id: string;
  fuente: string;
  features: Record<string, unknown>;
  elevacion: number | null;
  street_id: string | null;
  orden_en_calle: number | null;
  intersection_id: string | null;
  intersection_nombre: string | null;
  is_simulated: boolean;
  lat: number;
  lon: number;
  cadena: { street_id: string; nombre: string | null; posicion: number; aguas_arriba: string[]; aguas_abajo: string[] } | null;
  scores: Partial<Record<"antes" | "durante", ApiScore>>;
  observaciones: {
    id: string;
    fuente: string;
    tipo: string;
    tiene_foto: boolean;
    tiene_texto: boolean;
    ts: string;
    is_simulated?: boolean;
    clasificacion: unknown;
  }[];
  senales: ApiSenal[];
  ultima_limpieza: { fecha: string; is_simulated: boolean } | null;
}

export const getEscenarios = (o?: GetOpts) => apiGet<ApiEscenario[]>("/scenarios", o);
export function getRanking(id: string, o?: GetOpts, modo: ApiRanking["modo"] = "antes", zona?: string) {
  const query = new URLSearchParams({ modo, limit: "5000" });
  if (zona) query.set("zona", zona);
  return apiGet<ApiRanking>(`/scenarios/${encodeURIComponent(id)}/ranking?${query}`, o);
}
export const getFicha = (id: string, escenario: string, o?: GetOpts) => apiGet<ApiFicha>(`/sumideros/${encodeURIComponent(id)}?scenario_id=${encodeURIComponent(escenario)}`, o);

// --- Clima en vivo (backend/app/routers/clima.py, issue #13) ---

export type ModoClima = "seco" | "tormenta_inminente" | "durante" | "despues" | "sin_dato";

export interface ApiClima {
  modo: ModoClima;
  plazo: string | null;
  inicio_lluvia_pronosticado_utc: string | null;
  clima: number | null;
  lluvia_acum_24h_mm: number | null;
  racha_max_6h_kmh: number | null;
  lluvia_pronosticada_prox_24h_mm: number | null;
  lluvia_pronosticada_48h_mm: number | null;
  racha_max_pronosticada_48h_kmh: number | null;
  hora_dato_utc: string | null;
  fuente: { nombre: string; url: string; celda_latlon: [number, number] | null; licencia: string };
  /** false: Open-Meteo no respondió y es el último valor obtenido (o sin_dato). */
  vigente: boolean;
  consultado_utc: string | null;
  detalle?: string;
}

export const getClima = (o?: GetOpts) => apiGet<ApiClima>("/clima", { reintentos: 1, ...o });
