import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.db import get_conn
from app.main import app


@pytest.mark.skipif(os.getenv("DRENA_TEST_INTEGRACION") != "1", reason="DRENA_TEST_INTEGRACION=1 para correrlo")
def test_ficha_protege_datos_de_observaciones_vecinales():
    sumidero_id = f"test-ficha-{uuid4().hex}"
    texto = "Reporte ficticio de una rejilla tapada"
    foto = "observaciones/foto-ficticia.jpg"
    clasificacion_publica = {"tipo": "rejilla_tapada", "gravedad": "media"}
    clasificacion_completa = {
        **clasificacion_publica,
        "ubicacion_texto": "Domicilio ficticio 123",
        "desde_cuando": "Hora privada de ejemplo",
    }
    clasificacion_foto_publica = {"evaluable": True, "estado": "obstruida"}
    clasificacion_foto_completa = {**clasificacion_foto_publica, "nota": "Se lee Pasaje Ficticio 456 en la placa"}

    try:
        with get_conn() as conn:
            conn.execute(
                "insert into sumideros (id, fuente, geom) values (%s, 'manual', st_point(-70.6, -33.45, 4326))",
                (sumidero_id,),
            )
            reporte = conn.execute(
                "insert into observations (sumidero_id, fuente, tipo, texto) "
                "values (%s, 'vecino', 'texto', %s) returning id",
                (sumidero_id, texto),
            ).fetchone()["id"]
            foto_id = conn.execute(
                "insert into observations (sumidero_id, fuente, tipo, media_url) "
                "values (%s, 'vecino', 'foto_rejilla', %s) returning id",
                (sumidero_id, foto),
            ).fetchone()["id"]
            conn.execute(
                "insert into classifications (observation_id, resultado, modelo, prompt_version) "
                "values (%s, %s, 'test', 'v0')",
                (foto_id, Jsonb(clasificacion_foto_completa)),
            )
            conn.execute(
                "insert into classifications (observation_id, resultado, modelo, prompt_version) "
                "values (%s, %s, 'test', 'v0')",
                (reporte, Jsonb(clasificacion_completa)),
            )

        respuesta = TestClient(app).get(f"/sumideros/{sumidero_id}")
        assert respuesta.status_code == 200
        assert texto not in respuesta.text
        assert "Pasaje Ficticio 456" not in respuesta.text
        assert foto not in respuesta.text
        observaciones = respuesta.json()["observaciones"]
        assert len(observaciones) == 2
        for observacion in observaciones:
            assert {"texto", "media_url"}.isdisjoint(observacion)

        por_tipo = {observacion["tipo"]: observacion for observacion in observaciones}
        assert por_tipo["texto"]["tiene_texto"] is True
        assert por_tipo["texto"]["tiene_foto"] is False
        assert por_tipo["texto"]["clasificacion"] == clasificacion_publica
        assert por_tipo["foto_rejilla"]["tiene_texto"] is False
        assert por_tipo["foto_rejilla"]["tiene_foto"] is True
        assert por_tipo["foto_rejilla"]["clasificacion"] == clasificacion_foto_publica

        # La señal de equipo debe sobrevivir al límite de 20 observaciones de la ficha.
        with get_conn() as conn:
            conn.execute(
                "insert into classifications (observation_id, resultado, modelo, prompt_version) "
                "values (%s, %s, 'test', 'v1')",
                (foto_id, Jsonb({"evaluable": True, "rejilla": "tapada", "material": ["sedimento"]})),
            )
            conn.execute(
                "insert into observations (sumidero_id, fuente, tipo, texto) "
                "select %s, 'vecino', 'texto', 'Reporte posterior' from generate_series(1, 20)",
                (sumidero_id,),
            )
        ficha = TestClient(app).get(f"/sumideros/{sumidero_id}").json()
        assert len(ficha["observaciones"]) == 20
        assert all(o["tipo"] == "texto" for o in ficha["observaciones"])
        foto_usada, = [s for s in ficha["senales"] if s["senal"] == "rejilla" and s["usada"]]
        assert foto_usada["observation_id"] == str(foto_id)
        assert foto_usada["material"] == ["sedimento"]
    finally:
        with get_conn() as conn:
            conn.execute("delete from observations where sumidero_id = %s", (sumidero_id,))
            conn.execute("delete from sumideros where id = %s", (sumidero_id,))
