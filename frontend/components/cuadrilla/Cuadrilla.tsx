"use client";

// App de cuadrilla (/cuadrilla, issue #38): siguiente parada en grande, aviso cuando el despacho
// la cambia, "Llegué" / "Terminé" y cierre con foto. Consulta la ruta cada 2,5 s (sin Realtime).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Kicker, Logo } from "@/components/ui";
import { ApiError, getFicha, type ApiFicha } from "@/lib/api";
import { ESCENARIO_CENTRAL } from "@/lib/central";
import { equipoSugerido, evidenciaVigente, fotoParaEquipo, motivosCalculados, textoEvidencia } from "@/lib/decision";
import {
  cambiarEstado,
  cerrarMision,
  getCuadrillas,
  getRuta,
  horaSantiago,
  resultadoCierre,
  textoMotivo,
  urlGoogleMaps,
  type Cuadrilla as TCuadrilla,
  type Mision,
  type RespCierre,
  type RutaCuadrilla,
} from "@/lib/cuadrilla";
import { comprimirFoto } from "@/lib/reportar";
import "../reportar/reportar.css";
import "./cuadrilla.css";

const INTERVALO_MS = 2500;
const INTERVALO_FICHA_MS = 30_000; // la evidencia cambia menos que la ruta
const CLAVE_CUADRILLA = "drena.cuadrilla";

const ESTADO_TXT: Record<string, string> = { pendiente: "Pendiente", en_camino: "En camino", en_sitio: "En el lugar" };

const EQUIPO_TXT: Record<string, string> = { basica: "herramientas manuales", hidrojet: "hidrojet" };
const PUNTAJE = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });

type Aviso = { texto: string; motivo: string; hora: string | null };
type Cierre = { resp: RespCierre; nombre: string };

function leerCuadrilla(): string | null {
  const q = new URLSearchParams(window.location.search).get("id");
  if (q) return q;
  try {
    return localStorage.getItem(CLAVE_CUADRILLA);
  } catch {
    return null;
  }
}

function guardarCuadrilla(id: string | null) {
  try {
    if (id) localStorage.setItem(CLAVE_CUADRILLA, id);
    else localStorage.removeItem(CLAVE_CUADRILLA);
  } catch {}
  const u = new URL(window.location.href);
  if (id) u.searchParams.set("id", id);
  else u.searchParams.delete("id");
  window.history.replaceState(null, "", u);
}

function Elegir({ onElegir }: { onElegir: (id: string) => void }) {
  const [lista, setLista] = useState<TCuadrilla[] | null>(null);
  const [error, setError] = useState("");
  const cargar = useCallback(() => {
    setError("");
    setLista(null);
    getCuadrillas()
      .then(setLista)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(cargar, [cargar]);
  return (
    <section className="rp-sec">
      <Kicker tone="accent">Cuadrilla</Kicker>
      <h1 className="rp-h1">¿Qué cuadrilla eres?</h1>
      {error ? (
        <>
          <p className="rp-p rp-warn">{error}</p>
          <Button size="lg" className="rp-big" onClick={cargar}>
            Reintentar
          </Button>
        </>
      ) : !lista ? (
        <p className="rp-p">Cargando cuadrillas… (el servidor puede tardar hasta un minuto en despertar)</p>
      ) : lista.length === 0 ? (
        <p className="rp-p">No hay cuadrillas cargadas.</p>
      ) : (
        lista.map((c) => (
          <button key={c.id} className="cq-crew" onClick={() => onElegir(c.id)}>
            <b>{c.nombre}</b>
            <span>
              {c.carga} {c.carga === 1 ? "misión" : "misiones"} · {c.equipamiento.map((e) => EQUIPO_TXT[e] ?? e).join(", ")}
              {c.is_simulated && " · simulada"}
            </span>
          </button>
        ))
      )}
    </section>
  );
}

/** Fichas de las rejillas de la ruta: la esquina completa y la evidencia de la siguiente parada. */
function useFichas(ids: string[], siguiente: string | null) {
  const [fichas, setFichas] = useState<Record<string, ApiFicha | "error">>({});
  const clave = ids.join("|");
  useEffect(() => {
    let vigente = true;
    for (const id of clave ? clave.split("|") : []) {
      if (fichas[id] && fichas[id] !== "error") continue;
      getFicha(id, ESCENARIO_CENTRAL, { reintentos: 0, cache: "no-store" })
        .then((f) => vigente && setFichas((prev) => ({ ...prev, [id]: f })))
        .catch(() => vigente && setFichas((prev) => (prev[id] ? prev : { ...prev, [id]: "error" })));
    }
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);
  // La siguiente parada se refresca: una foto nueva puede cambiar lo que hay que llevar
  useEffect(() => {
    if (!siguiente) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      getFicha(siguiente, ESCENARIO_CENTRAL, { reintentos: 0, cache: "no-store" })
        .then((f) => setFichas((prev) => ({ ...prev, [siguiente]: f })))
        .catch(() => {});
    }, INTERVALO_FICHA_MS);
    return () => clearInterval(t);
  }, [siguiente]);
  return fichas;
}

function fechaCorta(fecha: string) {
  const d = new Date(`${fecha}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? fecha : d.toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Santiago" });
}

/** Por qué esta parada: lo observado y lo calculado van por separado, con su hora y su origen. */
function PorQue({ ficha }: { ficha: ApiFicha | "error" | undefined }) {
  if (!ficha) return <p className="rp-small" role="status">Cargando el detalle de la rejilla…</p>;
  if (ficha === "error") return <p className="rp-small" role="status">Sin detalle de la rejilla por ahora. La parada sigue vigente.</p>;
  // El equipo sale de la última foto de rejilla, aunque después haya llegado una de agua
  const rejilla = fotoParaEquipo(ficha);
  const ev = evidenciaVigente(ficha.observaciones) ?? rejilla;
  const equipo = equipoSugerido(rejilla);
  const score = ficha.scores.durante ?? ficha.scores.antes;
  const motivos = motivosCalculados(score?.detalle?.aportes);
  return (
    <dl className="cq-porque">
      <div className={ev ? `cq-dato ${ev.nivelAgua ? "cq-dato--agua" : "cq-dato--obs"}` : "cq-dato"}>
        <dt>Observado{ev ? ` · ${horaSantiago(ev.ts)}` : ""}</dt>
        <dd>{ev ? `${textoEvidencia(ev)}${ev.simulada ? " · simulado" : ""}` : "Sin fotos ni reportes vigentes"}</dd>
      </div>
      {rejilla && ev && rejilla.ts !== ev.ts && (
        <div className="cq-dato cq-dato--obs">
          <dt>Observado · {horaSantiago(rejilla.ts)}</dt>
          <dd>{textoEvidencia(rejilla)}{rejilla.simulada ? " · simulado" : ""}</dd>
        </div>
      )}
      <div className="cq-dato">
        <dt>Prioridad calculada</dt>
        <dd>
          {score?.prioridad != null ? `Puntaje ${PUNTAJE.format(score.prioridad)}` : "Sin puntaje"}
          {motivos.length > 0 && ` · pesan ${motivos.join(" y ")}`}
        </dd>
      </div>
      {equipo && (
        <div className={`cq-dato cq-dato--equipo cq-dato--${equipo}`}>
          <dt>Qué llevar</dt>
          <dd>{equipo === "hidrojet" ? "Hidrojet: la última foto muestra sedimento" : "Herramientas manuales: hojas o basura en la última foto"}</dd>
        </div>
      )}
      {ficha.ultima_limpieza && (
        <div className="cq-dato cq-dato--nota">
          <dt>Última limpieza registrada</dt>
          <dd>{fechaCorta(ficha.ultima_limpieza.fecha)}{ficha.ultima_limpieza.is_simulated ? " · dato simulado" : ""}</dd>
        </div>
      )}
    </dl>
  );
}

function ResultadoCierre({ c, onSeguir }: { c: Cierre; onSeguir: () => void }) {
  const r = resultadoCierre(c.resp);
  const titulo = { verificado: "Rejilla verificada limpia", sin_verificar: "Misión cerrada sin verificar", rechazado: "Sigue tapada: la misión continúa" }[r];
  const texto = {
    verificado: "Claude revisó la foto y la rejilla se ve despejada. La misión quedó cerrada.",
    sin_verificar: "La misión quedó cerrada, pero la foto no se pudo verificar. La central la revisará.",
    rechazado: "La foto muestra la rejilla todavía obstruida. Termina la limpieza y vuelve a sacar la foto.",
  }[r];
  return (
    <section className={`rp-sec cq-res cq-res--${r}`}>
      <Kicker tone={r === "rechazado" ? "danger" : "accent"}>{c.nombre}</Kicker>
      <h1 className="rp-h1">{titulo}</h1>
      <p className="rp-p">{texto}</p>
      {r === "rechazado" && c.resp.motivo && <p className="rp-small">{c.resp.motivo}</p>}
      <Button variant="primary" size="lg" className="rp-big" onClick={onSeguir}>
        {r === "rechazado" ? "Volver a la misión" : "Ver la siguiente parada"}
      </Button>
    </section>
  );
}

export default function Cuadrilla() {
  const [crewId, setCrewId] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [crew, setCrew] = useState<TCuadrilla | null>(null);
  const [ruta, setRuta] = useState<RutaCuadrilla | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cierre, setCierre] = useState<Cierre | null>(null);
  const siguienteRef = useRef<string | null | undefined>(undefined); // undefined = aún no se carga
  const propioRef = useRef<string | null>(null); // misión que cerró esta app: no es un cambio "de la central"
  const enCursoRef = useRef(false);
  const fotoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCrewId(leerCuadrilla());
    setListo(true);
  }, []);

  useEffect(() => {
    if (!crewId) return;
    getCuadrillas()
      .then((l) => setCrew(l.find((c) => c.id === crewId) ?? null))
      .catch(() => {});
  }, [crewId]);

  const actualizar = useCallback(async () => {
    if (!crewId || enCursoRef.current) return;
    enCursoRef.current = true;
    try {
      const r = await getRuta(crewId);
      setSinConexion(false);
      setRuta(r);
      const sig = r.misiones[0] ?? null;
      const id = sig?.mission_id ?? null;
      const previo = siguienteRef.current;
      if (previo !== undefined && previo !== id && id && previo !== propioRef.current) {
        const c = r.ultimo_cambio;
        setAviso({
          texto: `Nueva siguiente parada: ${sig.nombre}`,
          motivo: c ? textoMotivo(c) : "la central recalculó el plan",
          hora: c?.hora ? horaSantiago(c.hora) : null,
        });
        try {
          navigator.vibrate?.([200, 100, 200]);
        } catch {}
      }
      siguienteRef.current = id;
    } catch (e) {
      if (e instanceof ApiError && e.estado === 404) {
        setError(`La cuadrilla ${crewId} no existe.`);
        setCrewId(null);
        guardarCuadrilla(null);
      } else setSinConexion(true);
    } finally {
      enCursoRef.current = false;
    }
  }, [crewId]);

  useEffect(() => {
    if (!crewId) return;
    siguienteRef.current = undefined;
    setRuta(null);
    setAviso(null);
    actualizar();
    const t = setInterval(() => {
      if (!document.hidden) actualizar();
    }, INTERVALO_MS);
    const vis = () => !document.hidden && actualizar();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [crewId, actualizar]);

  const elegir = (id: string) => {
    setError("");
    guardarCuadrilla(id);
    setCrewId(id);
  };

  async function avanzar(m: Mision, destino: "en_camino" | "en_sitio") {
    setError("");
    setOcupado(m.mission_id);
    try {
      if (destino === "en_sitio" && m.estado === "pendiente") await cambiarEstado(m.mission_id, "en_camino");
      await cambiarEstado(m.mission_id, destino);
    } catch (e) {
      setError(e instanceof ApiError && e.estado === 409 ? "La misión cambió de estado en otro dispositivo. Actualicé la lista." : (e as Error).message);
    } finally {
      setOcupado(null);
      await actualizar();
    }
  }

  async function cerrar(m: Mision, file: File) {
    setError("");
    setOcupado(m.mission_id);
    try {
      const foto = await comprimirFoto(file);
      propioRef.current = m.mission_id;
      const resp = await cerrarMision(m.mission_id, foto, file.name || "cierre.jpg");
      setCierre({ resp, nombre: m.nombre });
      setAviso(null);
    } catch (e) {
      propioRef.current = null;
      setError(e instanceof ApiError && e.estado === 409 ? "La misión ya no se puede cerrar (cambió de estado). Actualicé la lista." : `No se pudo cerrar: ${(e as Error).message}`);
    } finally {
      setOcupado(null);
      if (fotoRef.current) fotoRef.current.value = "";
      await actualizar();
    }
  }

  const misiones = ruta?.misiones ?? [];
  const sig = misiones[0];
  const resto = misiones.slice(1);
  const fichas = useFichas(
    misiones.flatMap((m) => (m.sumidero_id ? [m.sumidero_id] : [])),
    sig?.sumidero_id ?? null,
  );

  if (!listo) return null;

  const fichaDe = (m: Mision) => (m.sumidero_id ? fichas[m.sumidero_id] : undefined);
  const nombreDe = (m: Mision) => {
    const f = fichaDe(m);
    return (f && f !== "error" && f.intersection_nombre) || m.nombre;
  };
  const conCoord = misiones.filter((m): m is Mision & { lat: number; lon: number } => m.lat != null && m.lon != null);

  return (
    <main className="rp cq">
      <header className="rp-head">
        <Logo size={24} />
        {crewId && (
          <button className="rp-link cq-cambiar" onClick={() => (guardarCuadrilla(null), setCrewId(null), setCrew(null))}>
            Cambiar cuadrilla
          </button>
        )}
      </header>

      {!crewId ? (
        <>
          {error && <p className="rp-p rp-warn">{error}</p>}
          <Elegir onElegir={elegir} />
        </>
      ) : cierre ? (
        <ResultadoCierre c={cierre} onSeguir={() => setCierre(null)} />
      ) : (
        <>
          <div className="cq-crewbar">
            <b>{crew?.nombre ?? crewId}</b>
            {crew?.is_simulated && <span className="cq-tag">Cuadrilla simulada · demo</span>}
            <span className={`cq-live ${sinConexion ? "is-off" : ""}`}>{sinConexion ? "Sin conexión · reintentando" : "En vivo"}</span>
          </div>

          {aviso && (
            <div className="cq-aviso" role="alert">
              <div>
                <b>{aviso.texto}</b>
                <span>
                  Motivo: {aviso.motivo}
                  {aviso.hora && ` · ${aviso.hora}`}
                </span>
              </div>
              <button aria-label="Cerrar aviso" onClick={() => setAviso(null)}>
                ✕
              </button>
            </div>
          )}

          {error && <p className="rp-p rp-warn">{error}</p>}

          {!ruta ? (
            <p className="rp-p">Cargando la ruta…</p>
          ) : !sig ? (
            <section className="rp-sec rp-center">
              <h1 className="rp-h1">Sin misiones asignadas</h1>
              <p className="rp-p">Cuando la central te asigne una rejilla aparecerá aquí sola.</p>
            </section>
          ) : (
            <>
              <section className="cq-next">
                <Kicker tone="accent">Siguiente parada · {ESTADO_TXT[sig.estado] ?? sig.estado}</Kicker>
                <h1 className="cq-next__name">{nombreDe(sig)}</h1>
                {sig.sumidero_id && <p className="rp-small">Rejilla {sig.sumidero_id}</p>}
                {sig.sumidero_id && <PorQue ficha={fichaDe(sig)} />}
                <div className="rp-two">
                  {sig.estado === "pendiente" && (
                    <Button size="lg" className="rp-big" disabled={!!ocupado} onClick={() => avanzar(sig, "en_camino")}>
                      Voy en camino
                    </Button>
                  )}
                  {sig.estado !== "en_sitio" && (
                    <Button variant="primary" size="lg" className="rp-big" disabled={!!ocupado} onClick={() => avanzar(sig, "en_sitio")}>
                      Llegué
                    </Button>
                  )}
                  {sig.estado !== "pendiente" && (
                    <Button variant={sig.estado === "en_sitio" ? "primary" : "secondary"} size="lg" className="rp-big" disabled={!!ocupado} onClick={() => fotoRef.current?.click()}>
                      {ocupado === sig.mission_id ? "Enviando foto…" : "Terminé · foto de cierre"}
                    </Button>
                  )}
                  <input
                    ref={fotoRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) cerrar(sig, f);
                    }}
                  />
                  {conCoord.length > 0 && (
                    <Button size="lg" className="rp-big" onClick={() => window.open(urlGoogleMaps(conCoord), "_blank", "noopener")}>
                      Abrir en Google Maps
                    </Button>
                  )}
                </div>
              </section>

              {resto.length > 0 && (
                <section className="rp-sec">
                  <Kicker>Después · {resto.length} {resto.length === 1 ? "parada" : "paradas"}</Kicker>
                  <ol className="cq-list">
                    {resto.map((m, i) => (
                      <li key={m.mission_id}>
                        <span className="cq-list__n">{i + 2}</span>
                        <span>{nombreDe(m)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
