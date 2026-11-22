"""Une la fórmula con la base: carga entradas, calcula y guarda en `scores`.

La fórmula (services/formula.py) es pura; aquí solo se arma su entrada desde
Supabase y se persiste la salida. Ver docs/plan-desarrollo.md §6 y §9.4.

Reglas de datos (revisión del PR #58):
- De cada observación cuenta solo su ÚLTIMA clasificación (una reclasificación no duplica).
- Los reportes de texto suben P solo si apuntan a obstrucción (`reportes_texto.tipos_que_suben_p`);
  un anegamiento no implica rejilla tapada: entra a la consecuencia como nivel de agua (Durante).
- Cada observación pesa según la confianza que Claude le dio (`confianza` en formula.yaml, #88 y #124):
  la foto de rejilla mueve P, cada texto suma su aporte y el agua entra a C con nivel · factor.
  `senales_sumidero` lista esas mismas lecturas para la ficha (`GET /sumideros/{id}`).
- `incluir_simulados=False` (prueba de campo) excluye todo dato simulado: sumideros, observaciones,
  historial de limpieza, features simuladas (`features_simuladas`) y casos sin observaciones reales.
  Ese cálculo NO se guarda en `scores`: el ranking de la demo no se pisa.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from psycopg import Connection
from psycopg.types.json import Jsonb

from app.config import get_formula_config
from app.services.formula import (
    Score,
    StreetChain,
    SumideroInput,
    calcular_ranking,
    elegir_agua,
    factor_confianza,
)

ZONA = ZoneInfo("America/Santiago")
_NIVELES_AGUA = ["sobre_vereda", "hasta_vereda", "cuneta", "sin_agua"]

# Última clasificación de cada observación
_ULTIMA_CLASIFICACION = """
    join lateral (
        select resultado from classifications cl
         where cl.observation_id = o.id
         order by cl.created_at desc, cl.id desc
         limit 1
    ) c on true
"""


# Lecturas vigentes de cada clase de señal. Las usan el cálculo (`cargar_entradas`) y la ficha
# (`senales_sumidero`), así ambos aplican siempre las mismas vigencias y filtros.
_COLUMNAS = """o.id as observation_id, o.sumidero_id, o.fuente, o.tipo, o.ts, o.is_simulated,
               c.resultado->>'confianza' as confianza"""
_FILTRO_COMUN = """o.sumidero_id is not null
               and (%(sim)s or not o.is_simulated)
               and (%(sid)s::text is null or o.sumidero_id = %(sid)s)"""
_SQL_LECTURAS = {
    # Foto de rejilla evaluable: P (lo confirmado manda)
    "rejilla": f"""
        select {_COLUMNAS}, c.resultado->>'rejilla' as valor, c.resultado->'material' as material
          from observations o {_ULTIMA_CLASIFICACION}
         where o.tipo = 'foto_rejilla' and {_FILTRO_COMUN}
           and (c.resultado->>'evaluable')::boolean
           and c.resultado->>'rejilla' in ('limpia', 'parcial', 'tapada')
           and o.ts > now() - make_interval(hours => %(h_foto)s)
         order by o.sumidero_id, o.ts desc, o.id desc
    """,
    # Texto que apunta a obstrucción: suma a P si no hay foto
    "texto": f"""
        select {_COLUMNAS}, c.resultado->>'tipo' as valor
          from observations o {_ULTIMA_CLASIFICACION}
         where o.tipo = 'texto' and {_FILTRO_COMUN}
           and c.resultado->>'tipo' = any(%(tipos)s)
           and o.ts > now() - make_interval(hours => %(h_foto)s)
         order by o.sumidero_id, o.ts desc, o.id desc
    """,
    # Nivel de agua de cualquier observación: C en Durante
    "agua": f"""
        select {_COLUMNAS}, c.resultado->>'nivel_agua' as valor
          from observations o {_ULTIMA_CLASIFICACION}
         where {_FILTRO_COMUN}
           and c.resultado->>'nivel_agua' = any(%(niveles)s)
           and o.ts > now() - make_interval(hours => %(h_agua)s)
         order by o.sumidero_id, o.ts desc, o.id desc
    """,
}


def _lecturas(
    conn: Connection,
    cfg: Mapping[str, Any],
    incluir_simulados: bool = True,
    sumidero_id: str | None = None,
    agua: bool = True,
) -> dict[str, list[Mapping[str, Any]]]:
    """Observaciones vigentes por clase ('rejilla', 'texto', 'agua'), de la más nueva a la más antigua."""
    params = {
        "sim": incluir_simulados,
        "sid": sumidero_id,
        "h_foto": cfg["observado"]["vigencia_horas"],
        "h_agua": cfg["durante"].get("vigencia_agua_horas", 6),
        "tipos": list(cfg["reportes_texto"].get("tipos_que_suben_p", ["rejilla_tapada", "basura"])),
        "niveles": _NIVELES_AGUA,
    }
    return {
        clase: (conn.execute(sql, params).fetchall() if clase != "agua" or agua else [])
        for clase, sql in _SQL_LECTURAS.items()
    }


def senales_sumidero(
    conn: Connection, sumidero_id: str, cfg: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Resumen de las señales vigentes que afectan a un sumidero (#124), para la ficha.

    Una fila por lectura: clase de señal, fuente, tipo y hora de captura (UTC) de la
    observación, valor que leyó Claude, su confianza y el factor que aplica la fórmula.
    `usada` dice si la fórmula la toma hoy: la foto más reciente; los textos si no hay foto;
    el agua con mayor nivel · factor. `aplica_en` dice en qué modo entra al cálculo.
    Mismas reglas que el cálculo de la demo (`formula.yaml`, con datos simulados rotulados).
    """
    cfg = cfg or get_formula_config()
    lect = _lecturas(conn, cfg, incluir_simulados=True, sumidero_id=sumidero_id)
    elegida = elegir_agua([(r["valor"], r["confianza"]) for r in lect["agua"]], cfg)
    hay_foto = bool(lect["rejilla"])
    senales: list[dict[str, Any]] = []
    agua_marcada = False
    for clase in ("rejilla", "texto", "agua"):
        for i, r in enumerate(lect[clase]):
            if clase == "rejilla":
                usada = i == 0
            elif clase == "texto":
                usada = not hay_foto
            else:
                usada = not agua_marcada and (r["valor"], r["confianza"]) == elegida
                agua_marcada = agua_marcada or usada
            senales.append({
                "observation_id": r["observation_id"],
                "senal": clase,
                "fuente": r["fuente"],
                "tipo_observacion": r["tipo"],
                "ts": r["ts"],
                "valor": r["valor"],
                **({"material": [m for m in r["material"] or [] if m in ("hojas", "basura", "sedimento")]}
                   if clase == "rejilla" else {}),
                "confianza": r["confianza"],
                "factor_confianza": factor_confianza(r["confianza"], cfg),
                "aplica_en": ["durante"] if clase == "agua" else ["antes", "durante"],
                "usada": usada,
                "is_simulated": r["is_simulated"],
            })
    return senales


def hoy_santiago() -> date:
    return datetime.now(ZONA).date()


def _dias_norm(ultima: date | None, hoy: date, dias_max: float) -> float | None:
    if ultima is None:
        return None
    return min(1.0, max(0, (hoy - ultima).days) / dias_max)


def cargar_entradas(
    conn: Connection,
    scenario_id: str,
    modo: str,
    incluir_simulados: bool = True,
    cfg: Mapping[str, Any] | None = None,
) -> tuple[list[SumideroInput], list[StreetChain]]:
    """Arma la entrada de la fórmula desde la base."""
    cfg = cfg or get_formula_config()
    norm = cfg.get("normalizacion", {})
    vig_urgente = cfg["durante"].get("vigencia_urgente_horas", 6)
    feats_sim = set(cfg.get("features_simuladas", ["dias_sin_limpieza"]))
    sim = {"sim": incluir_simulados}

    scen = conn.execute("select parametros from scenarios where id = %s", (scenario_id,)).fetchone()
    if scen is None:
        raise KeyError(scenario_id)
    params = scen["parametros"] or {}

    rows = conn.execute(
        """
        select s.id, s.features, s.is_simulated,
               (select max(fecha) from cleaning_history ch
                 where ch.sumidero_id = s.id and (%(sim)s or not ch.is_simulated)) as ultima_limpieza
          from sumideros s
         where %(sim)s or not s.is_simulated
        """,
        sim,
    ).fetchall()

    lect = _lecturas(conn, cfg, incluir_simulados, agua=modo == "durante")

    # Última foto de rejilla evaluable y vigente (lo confirmado manda). Vienen de la más nueva
    # a la más antigua: la primera de cada sumidero es la que vale.
    fotos: dict[str, Mapping[str, Any]] = {}
    for r in lect["rejilla"]:
        fotos.setdefault(r["sumidero_id"], r)

    # Reportes de texto que apuntan a obstrucción (una fila por observación) con su confianza
    textos: dict[str, list[str | None]] = {}
    for r in lect["texto"]:
        textos.setdefault(r["sumidero_id"], []).append(r["confianza"])

    # Agua: la lectura vigente con mayor nivel · factor de confianza (#124)
    lecturas_agua: dict[str, list[tuple[str, str | None]]] = {}
    for r in lect["agua"]:
        lecturas_agua.setdefault(r["sumidero_id"], []).append((r["valor"], r["confianza"]))
    agua = {sid: elegir_agua(ls, cfg) for sid, ls in lecturas_agua.items()}

    urgentes: set[str] = set()
    if modo == "durante":
        urgentes = {
            r["sumidero_id"]
            for r in conn.execute(
                """
                select ca.sumidero_id from cases ca
                 where ca.urgente and ca.sumidero_id is not null
                   and ca.estado not in ('resuelto', 'descartado')
                   and ca.abierto_at > now() - make_interval(hours => %(h)s)
                   and (%(sim)s or exists (
                         select 1 from case_observations co join observations o on o.id = co.observation_id
                          where co.case_id = ca.id and not o.is_simulated))
                """,
                {"h": vig_urgente, **sim},
            )
        }

    hoy = hoy_santiago()
    entradas = []
    for r in rows:
        f = dict(r["features"] or {})
        if not incluir_simulados:
            for k in feats_sim:
                f.pop(k, None)
        if "clima" in params:  # el escenario fija la lluvia reciente/pronosticada para toda la zona
            f["clima"] = params["clima"]
        if f.get("dias_sin_limpieza") is None and (incluir_simulados or "dias_sin_limpieza" not in feats_sim):
            d = _dias_norm(r["ultima_limpieza"], hoy, norm.get("dias_sin_limpieza_max", 90))
            if d is not None:
                f["dias_sin_limpieza"] = d
        foto = fotos.get(r["id"]) or {}
        confs_texto = textos.get(r["id"], [])
        nivel, conf_agua = agua.get(r["id"]) or (None, None)
        entradas.append(
            SumideroInput(
                id=r["id"],
                features=f,
                rejilla_observada=foto.get("valor"),
                confianza_foto=foto.get("confianza"),
                reportes_texto=len(confs_texto),
                confianza_textos=confs_texto,
                nivel_agua=nivel,
                confianza_agua=conf_agua,
                urgente=r["id"] in urgentes,
            )
        )

    ids = {e.id for e in entradas}
    chains = [
        StreetChain(r["street_id"], r["sumidero_ids"], r["distancias_m"])
        for r in conn.execute("select street_id, sumidero_ids, distancias_m from street_chains")
        if ids.intersection(r["sumidero_ids"])
    ]
    return entradas, chains


def guardar_scores(conn: Connection, scenario_id: str, modo: str, scores: list[Score]) -> None:
    """Reemplaza los scores del escenario y modo.

    La explicación se conserva mientras sean iguales sus datos de entrada.
    El rank no cuenta: si otro sumidero sube, los que adelanta no cambian sus propias
    razones (la explicación no menciona la posición).
    """
    with conn.transaction():
        conn.execute(
            "delete from scores where scenario_id = %s and modo = %s and not (sumidero_id = any(%s))",
            (scenario_id, modo, [s.sumidero_id for s in scores]),
        )
        with conn.cursor() as cur:
            cur.executemany(
                """
                insert into scores (sumidero_id, scenario_id, modo, p_pred, p_obs, p_ef, c,
                                    prioridad, rank, detalle, computed_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (sumidero_id, scenario_id, modo) do update set
                  p_pred = excluded.p_pred, p_obs = excluded.p_obs, p_ef = excluded.p_ef,
                  c = excluded.c, prioridad = excluded.prioridad, rank = excluded.rank,
                  detalle = excluded.detalle, computed_at = excluded.computed_at,
                  explicacion = case
                    when scores.prioridad is not distinct from excluded.prioridad
                     and scores.p_ef is not distinct from excluded.p_ef
                     and scores.c is not distinct from excluded.c
                     and scores.detalle = excluded.detalle
                    then scores.explicacion
                    else null
                  end
                """,
                [
                    (s.sumidero_id, scenario_id, modo, s.p_pred, s.p_obs, s.p_ef, s.c, s.prioridad,
                     s.rank, Jsonb({**s.detalle, "p": s.p, "urgente": s.urgente, "incluye_simulados": True}))
                    for s in scores
                ],
            )


def calcular(conn: Connection, scenario_id: str, modo: str, incluir_simulados: bool = True) -> list[Score]:
    """Carga y calcula sin guardar. Cada score registra con qué datos se calculó.

    Sin simulados (prueba de campo, §8.1) usa `formula_validacion.yaml`: mismos parámetros
    con w_dias = w_cam = 0 y los demás pesos reescalados para sumar 1.
    """
    nombre_cfg = "formula" if incluir_simulados else "formula_validacion"
    cfg = get_formula_config(nombre_cfg)
    entradas, chains = cargar_entradas(conn, scenario_id, modo, incluir_simulados, cfg)
    scores = calcular_ranking(entradas, chains, cfg, modo)
    for s in scores:
        s.detalle["incluye_simulados"] = incluir_simulados
        s.detalle["config"] = nombre_cfg
    return scores


def recalcular(conn: Connection, scenario_id: str, modo: str) -> list[Score]:
    """Calcula con todos los datos y guarda en `scores`. Lo llaman /formula/recompute y POST /observations.

    Para la prueba de campo (sin simulados) usar `calcular(..., incluir_simulados=False)`,
    que no toca la tabla de la demo.
    """
    scores = calcular(conn, scenario_id, modo, incluir_simulados=True)
    guardar_scores(conn, scenario_id, modo, scores)
    return scores


def recalcular_todo(conn: Connection) -> dict[str, int]:
    """Recalcula todos los escenarios en ambos modos."""
    out = {}
    for r in conn.execute("select id from scenarios order by id").fetchall():
        for modo in ("antes", "durante"):
            out[f"{r['id']}/{modo}"] = len(recalcular(conn, r["id"], modo))
    return out
