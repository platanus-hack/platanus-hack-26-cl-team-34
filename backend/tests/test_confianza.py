"""Ponderación por la confianza de Claude en texto, agua y la ficha del sumidero (#124).

La foto de rejilla ya se prueba en test_formula.py (#88). Aquí, sin base de datos.
"""
from datetime import UTC, datetime

import pytest

from app.config import get_formula_config
from app.services import scoring
from app.services.formula import (
    SumideroInput,
    calcular_ranking,
    consecuencia,
    elegir_agua,
    factor_confianza,
    p_final,
)

CFG = get_formula_config()
VALIDACION = get_formula_config("formula_validacion")
FACTORES = [("alta", 1.0), ("media", 0.7), ("baja", 0.4)]


def test_factor_confianza():
    for conf, f in FACTORES:
        assert factor_confianza(conf, CFG) == f
    assert factor_confianza(None, CFG) == 1.0          # texto o clasificación antigua
    assert factor_confianza("desconocida", CFG) == 1.0
    assert factor_confianza("baja", VALIDACION) == 1.0  # la validación congelada no pondera


# --- Texto ------------------------------------------------------------------
@pytest.mark.parametrize(("confianza", "factor"), FACTORES)
def test_texto_aporta_segun_su_confianza(confianza, factor):
    rt = CFG["reportes_texto"]
    s = SumideroInput("a", {}, reportes_texto=1, confianza_textos=[confianza])
    p, _, _, det = p_final(s, CFG)
    assert p == pytest.approx(rt["factor"] * rt["aporte_por_reporte"] * factor)
    assert det["factores_confianza_texto"] == [factor]


def test_texto_con_confianza_baja_aporta_menos_que_con_alta():
    def p(conf):
        return p_final(SumideroInput("a", {"arboles": 1}, reportes_texto=1, confianza_textos=[conf]), CFG)[0]

    assert p("alta") > p("media") > p("baja") > p_final(SumideroInput("a", {"arboles": 1}), CFG)[0]


def test_texto_sin_confianza_pesa_como_antes():
    """Lecturas texto-v1 guardadas antes de #124 no traen confianza: el aporte y el detalle no cambian."""
    sin = p_final(SumideroInput("a", {}, reportes_texto=2), CFG)
    nulos = p_final(SumideroInput("a", {}, reportes_texto=2, confianza_textos=[None, None]), CFG)
    assert sin[0] == nulos[0] and sin[3] == nulos[3]
    assert "factores_confianza_texto" not in nulos[3]


def test_texto_mezcla_confianzas_y_respeta_el_tope():
    rt = CFG["reportes_texto"]
    paso = rt["factor"] * rt["aporte_por_reporte"]
    # Dos reportes y solo uno con confianza: el otro cuenta con factor 1
    p, _, _, det = p_final(SumideroInput("a", {}, reportes_texto=2, confianza_textos=["baja"]), CFG)
    assert p == pytest.approx(paso * (0.4 + 1.0)) and det["factores_confianza_texto"] == [0.4, 1.0]
    muchos = SumideroInput("a", {}, reportes_texto=50, confianza_textos=["media"] * 50)
    assert p_final(muchos, CFG)[0] == pytest.approx(rt["max_aporte"])


def test_texto_no_cuenta_si_hay_foto():
    s = SumideroInput("a", {}, rejilla_observada="limpia", reportes_texto=3, confianza_textos=["alta"] * 3)
    p, _, po, det = p_final(s, CFG)
    assert p == po and "aporte_reportes_texto" not in det


# --- Agua -------------------------------------------------------------------
@pytest.mark.parametrize(("confianza", "factor"), FACTORES)
def test_agua_sube_c_segun_su_confianza(confianza, factor):
    w = CFG["durante"]["w_agua"]
    nivel = CFG["durante"]["nivel_agua"]["sobre_vereda"]
    c = consecuencia(0.5, 0, CFG, "sobre_vereda", "durante", factor_confianza(confianza, CFG))
    assert c == pytest.approx(consecuencia(0.5, 0, CFG) * (1 + w * nivel * factor))


def test_agua_con_confianza_baja_sube_menos_la_prioridad():
    def score(conf):
        s = SumideroInput("a", {"arboles": 1, "area_aporte": 500}, nivel_agua="hasta_vereda", confianza_agua=conf)
        return calcular_ranking([s], [], CFG, "durante")[0]

    alta, media, baja, sin = score("alta"), score("media"), score("baja"), score(None)
    seco = calcular_ranking([SumideroInput("a", {"arboles": 1, "area_aporte": 500})], [], CFG, "durante")[0]
    assert alta.prioridad > media.prioridad > baja.prioridad > seco.prioridad
    assert sin.prioridad == alta.prioridad  # sin confianza (texto) pesa como antes
    assert baja.detalle["confianza_agua"] == "baja" and baja.detalle["factor_confianza_agua"] == 0.4
    assert sin.detalle["factor_confianza_agua"] == 1.0


def test_agua_no_cuenta_en_antes():
    s = SumideroInput("a", {"area_aporte": 500}, nivel_agua="sobre_vereda", confianza_agua="baja")
    det = calcular_ranking([s], [], CFG, "antes")[0].detalle
    assert "nivel_agua" not in det and "factor_confianza_agua" not in det


def test_elegir_agua_toma_el_mayor_nivel_por_factor():
    # sobre_vereda·0,4 = 0,4 > cuneta·1 = 0,3
    assert elegir_agua([("cuneta", "alta"), ("sobre_vereda", "baja")], CFG) == ("sobre_vereda", "baja")
    # hasta_vereda·1 = 0,6 > sobre_vereda·0,4 = 0,4: ya no gana el peor nivel
    assert elegir_agua([("sobre_vereda", "baja"), ("hasta_vereda", "alta")], CFG) == ("hasta_vereda", "alta")
    # empate exacto de nivel·factor (0,6 vs 0,6): gana el nivel más alto
    assert elegir_agua([("hasta_vereda", None), ("sobre_vereda", "media"), ("hasta_vereda", "alta")],
                       {**CFG, "confianza": {"alta": 1.0, "media": 0.6}}) == ("sobre_vereda", "media")
    assert elegir_agua([("hasta_vereda", "media"), ("hasta_vereda", None)], CFG) == ("hasta_vereda", None)
    assert elegir_agua([], CFG) is None
    assert elegir_agua([("no_evaluable", "alta")], CFG) is None


def test_elegir_agua_sin_tabla_toma_el_peor_nivel():
    """Con la config de validación (sin `confianza`) vuelve el criterio anterior: el peor nivel."""
    lecturas = [("cuneta", "alta"), ("sobre_vereda", "baja"), ("hasta_vereda", "media")]
    assert elegir_agua(lecturas, VALIDACION)[0] == "sobre_vereda"


def test_validacion_congelada_no_cambia_con_confianzas():
    """formula_validacion.yaml no tiene `confianza`: las confianzas no mueven ningún puntaje."""
    base = dict(features={"arboles": 1, "area_aporte": 500}, rejilla_observada="tapada", reportes_texto=0,
                nivel_agua="sobre_vereda")
    con = SumideroInput("a", **base, confianza_foto="baja", confianza_agua="baja")
    sin = SumideroInput("a", **base)
    texto_con = SumideroInput("b", {"area_aporte": 100}, reportes_texto=2, confianza_textos=["baja", "media"])
    texto_sin = SumideroInput("b", {"area_aporte": 100}, reportes_texto=2)
    for modo in ("antes", "durante"):
        a = calcular_ranking([con, texto_con], [], VALIDACION, modo)
        b = calcular_ranking([sin, texto_sin], [], VALIDACION, modo)
        assert [(x.sumidero_id, x.prioridad) for x in a] == [(x.sumidero_id, x.prioridad) for x in b]


# --- Ficha: GET /sumideros/{id} ---------------------------------------------
class _ConnFalsa:
    """Responde cada consulta de lecturas con las filas de su clase."""

    def __init__(self, filas):
        self.filas, self.params = filas, []

    def execute(self, sql, params=None):
        self.params.append(params)
        clase = next(k for k, v in scoring._SQL_LECTURAS.items() if v == sql)
        filas = self.filas.get(clase, [])
        return type("R", (), {"fetchall": lambda _self: filas})()


def _fila(obs, valor, confianza, tipo="foto_rejilla", fuente="vecino", hora=12, simulada=False):
    return {"observation_id": obs, "sumidero_id": "s1", "fuente": fuente, "tipo": tipo,
            "ts": datetime(2026, 11, 21, hora, tzinfo=UTC), "is_simulated": simulada,
            "confianza": confianza, "valor": valor, "material": []}


def test_senales_de_la_ficha_con_fuente_hora_y_confianza():
    conn = _ConnFalsa({
        "rejilla": [_fila("f2", "tapada", "media", hora=13), _fila("f1", "limpia", "alta", hora=11)],
        "texto": [_fila("t1", "rejilla_tapada", None, tipo="texto")],
        "agua": [_fila("a1", "sobre_vereda", "baja", tipo="foto_agua"),
                 _fila("a2", "hasta_vereda", "alta", tipo="cuadro_camara", fuente="camara", simulada=True),
                 _fila("t1", "cuneta", None, tipo="texto")],
    })
    senales = scoring.senales_sumidero(conn, "s1", CFG)
    assert all(p["sid"] == "s1" and p["sim"] is True for p in conn.params)
    por = {(s["senal"], s["observation_id"]): s for s in senales}
    assert len(senales) == 6

    foto = por[("rejilla", "f2")]
    assert foto["usada"] and not por[("rejilla", "f1")]["usada"]          # manda la más reciente
    assert (foto["fuente"], foto["tipo_observacion"], foto["valor"]) == ("vecino", "foto_rejilla", "tapada")
    assert foto["confianza"] == "media" and foto["factor_confianza"] == 0.7
    assert foto["ts"] == datetime(2026, 11, 21, 13, tzinfo=UTC)          # hora de captura, UTC
    assert foto["aplica_en"] == ["antes", "durante"]

    texto = por[("texto", "t1")]
    assert texto["confianza"] is None and texto["factor_confianza"] == 1.0
    assert not texto["usada"]                                            # hay foto: el texto no suma

    # hasta_vereda·1,0 = 0,6 gana a sobre_vereda·0,4 y a cuneta·1,0
    usadas_agua = [s["observation_id"] for s in senales if s["senal"] == "agua" and s["usada"]]
    assert usadas_agua == ["a2"]
    camara = por[("agua", "a2")]
    assert camara["fuente"] == "camara" and camara["is_simulated"] is True and camara["aplica_en"] == ["durante"]


def test_senales_sin_foto_los_textos_cuentan():
    conn = _ConnFalsa({"texto": [_fila("t1", "basura", None, tipo="texto"),
                                 _fila("t2", "rejilla_tapada", "baja", tipo="texto")]})
    senales = scoring.senales_sumidero(conn, "s1", CFG)
    assert [s["usada"] for s in senales] == [True, True]
    assert [s["factor_confianza"] for s in senales] == [1.0, 0.4]


def test_senales_no_exponen_texto_ni_foto():
    """La ficha es de lectura pública: solo valores cerrados, sin texto libre ni rutas de fotos."""
    fila = {**_fila("f1", "tapada", "alta"), "material": ["sedimento", "nota privada"]}
    conn = _ConnFalsa({"rejilla": [fila]})
    (s,) = scoring.senales_sumidero(conn, "s1", CFG)
    assert set(s) == {"observation_id", "senal", "fuente", "tipo_observacion", "ts", "valor", "confianza",
                      "factor_confianza", "aplica_en", "usada", "is_simulated", "material"}
    assert s["material"] == ["sedimento"]


# --- Texto de punta a punta: clasificador → classifications → scores.detalle (revisión de #135) ---
import json  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from app.services import cache, claude_common  # noqa: E402
from app.services.claude_text import PROMPT_VERSION_TEXTO, SCHEMA_TEXTO, leer_texto  # noqa: E402


class _ClaudeFalso:
    """Cliente de Claude que responde, en orden, las lecturas dadas."""

    def __init__(self, respuestas):
        self.respuestas = [json.dumps(r) for r in respuestas]
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        return SimpleNamespace(stop_reason="end_turn", model="claude-test", stop_details=None,
                               content=[SimpleNamespace(type="text", text=self.respuestas.pop(0))])


class _BaseFalsa:
    """Lo mínimo de Postgres para `cargar_entradas`: guarda el `resultado` tal como lo persiste
    `insertar_clasificacion` y resuelve `resultado->>'campo'` y los filtros de cada lectura."""

    def __init__(self, sumideros):
        self.sumideros, self.obs = sumideros, []

    def guardar(self, sumidero_id, tipo, resultado, fuente="vecino"):
        self.obs.append({"observation_id": f"o{len(self.obs)}", "sumidero_id": sumidero_id, "fuente": fuente,
                         "tipo": tipo, "ts": datetime.now(UTC), "is_simulated": False,
                         "resultado": json.loads(json.dumps(resultado))})  # ida y vuelta por jsonb

    def _filas(self, clase, params):
        out = []
        for o in self.obs:
            r = o["resultado"]
            if clase == "rejilla":
                ok, valor = o["tipo"] == "foto_rejilla" and r.get("evaluable") and \
                    r.get("rejilla") in ("limpia", "parcial", "tapada"), r.get("rejilla")
            elif clase == "texto":
                ok, valor = o["tipo"] == "texto" and r.get("tipo") in params["tipos"], r.get("tipo")
            else:
                ok, valor = r.get("nivel_agua") in params["niveles"], r.get("nivel_agua")
            if ok:
                out.append({**{k: v for k, v in o.items() if k != "resultado"},
                            "confianza": r.get("confianza"), "valor": valor})
        return out

    def execute(self, sql, params=None):
        clase = next((k for k, v in scoring._SQL_LECTURAS.items() if v == sql), None)
        if clase:
            filas = self._filas(clase, params)
        elif "from scenarios" in sql:
            filas = [{"parametros": {}}]
        elif "from sumideros s" in sql:
            filas = [{"id": sid, "features": f, "is_simulated": False, "ultima_limpieza": None}
                     for sid, f in self.sumideros.items()]
        else:  # casos urgentes y cadenas: ninguno en esta prueba
            filas = []
        return _Filas(filas)


class _Filas(list):
    def fetchone(self):
        return self[0] if self else None

    def fetchall(self):
        return list(self)


@pytest.fixture
def claude_falso(monkeypatch):
    mem = {}
    monkeypatch.setattr(cache, "get", lambda k: mem.get(k))
    monkeypatch.setattr(cache, "put", lambda k, r, m: mem.__setitem__(k, {"respuesta": r, "modelo": m}))

    def usar(respuestas):
        cliente = _ClaudeFalso(respuestas)  # uno solo: cada llamada consume la siguiente respuesta
        monkeypatch.setattr(claude_common, "get_client", lambda: cliente)
    return usar


def _lectura(confianza, nivel="sin_agua", tipo="rejilla_tapada"):
    return {"tipo": tipo, "gravedad": "media", "personas_en_riesgo": False, "ubicacion_texto": None,
            "desde_cuando": None, "nivel_agua": nivel, "confianza": confianza}


def test_lectura_de_texto_pide_y_valida_confianza():
    assert "confianza" in SCHEMA_TEXTO["required"]
    assert SCHEMA_TEXTO["properties"]["confianza"]["enum"] == ["alta", "media", "baja"]
    assert PROMPT_VERSION_TEXTO == "texto-v2"  # la caché de texto-v1 (sin confianza) no se reusa


def test_texto_sin_respuesta_de_claude_queda_con_confianza_baja(claude_falso):
    claude_falso(["no es json", "tampoco"])
    r = leer_texto("Hay agua en la esquina, creo")
    assert r.fallo and r.resultado.confianza == "baja" and r.resultado.tipo == "otro"


def test_confianza_del_texto_llega_desde_el_clasificador_hasta_el_detalle(claude_falso):
    """La señal que entrega Claude se guarda, scoring la lee y la fórmula la deja en scores.detalle."""
    claude_falso([_lectura("alta", "hasta_vereda"), _lectura("baja", "hasta_vereda")])
    base = _BaseFalsa({"claro": {"area_aporte": 500}, "dudoso": {"area_aporte": 500}})
    for sid, texto in (("claro", "La rejilla de la esquina está llena de hojas y el agua llega al borde"),
                       ("dudoso", "Me dijeron que por ahí algo pasa con un sumidero")):
        r = leer_texto(texto)
        assert not r.fallo and r.meta()["prompt_version"] == "texto-v2"
        base.guardar(sid, "texto", r.resultado.model_dump(mode="json"))  # igual que insertar_clasificacion

    paso = CFG["reportes_texto"]["factor"] * CFG["reportes_texto"]["aporte_por_reporte"]
    for modo in ("antes", "durante"):
        entradas, chains = scoring.cargar_entradas(base, "base", modo, cfg=CFG)
        s = {x.sumidero_id: x for x in calcular_ranking(entradas, chains, CFG, modo)}
        claro, dudoso = s["claro"].detalle, s["dudoso"].detalle
        assert claro["factores_confianza_texto"] == [1.0] and dudoso["factores_confianza_texto"] == [0.4]
        assert claro["aporte_reportes_texto"] == pytest.approx(paso)
        assert dudoso["aporte_reportes_texto"] == pytest.approx(paso * 0.4)
        assert s["claro"].prioridad > s["dudoso"].prioridad
    # En Durante, el nivel de agua del texto también pesa según su confianza
    assert (claro["confianza_agua"], claro["factor_confianza_agua"]) == ("alta", 1.0)
    assert (dudoso["confianza_agua"], dudoso["factor_confianza_agua"]) == ("baja", 0.4)
    assert s["claro"].c > s["dudoso"].c
