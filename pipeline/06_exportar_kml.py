"""
Exporta las rejillas de la predicción congelada a KML, una ruta a pie por comuna desde el MUT.

Uso (desde la raíz del repo, después de 05_prediccion.py):
    pip install -r pipeline/requirements.txt
    python pipeline/06_exportar_kml.py

Salidas (en data/validacion/):
    rejillas_mut_providencia.kml
    rejillas_mut_las_condes.kml
    rutas_mut.meta.json        orden, distancias y sha256

Cada KML trae:
  - un punto por rejilla, con ID_IDE como nombre, en el orden de la ruta;
  - la descripción con el orden de visita, la calle y el rank de la predicción;
  - una línea con el recorrido a pie por las calles.

La ruta parte en el MUT y es abierta (no vuelve). Usa distancias reales por la red peatonal
de OSM ("walk"): vecino más cercano y luego mejora 2-opt. No es la ruta óptima garantizada,
pero no tiene cruces evitables.
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

SCRIPT_VERSION = "0.1.0"
UTM = 32719


def sha256(ruta):
    return hashlib.sha256(Path(ruta).read_bytes()).hexdigest()


def largo(orden, D):
    return sum(D[orden[i]][orden[i + 1]] for i in range(len(orden) - 1))


def ruta_abierta(D):
    """Índice 0 = MUT. Vecino más cercano + 2-opt sobre un camino abierto que parte en 0."""
    n = len(D)
    orden, libres = [0], set(range(1, n))
    while libres:
        u = orden[-1]
        v = min(libres, key=lambda j: (D[u][j], j))
        orden.append(v)
        libres.remove(v)
    mejoro = True
    while mejoro:
        mejoro = False
        for i in range(1, n - 1):
            for k in range(i + 1, n):
                nuevo = orden[:i] + orden[i : k + 1][::-1] + orden[k + 1 :]
                if largo(nuevo, D) < largo(orden, D) - 1e-6:
                    orden, mejoro = nuevo, True
    return orden


def kml(nombre, puntos, linea):
    pm = []
    for p in puntos:
        desc = escape(f"Parada {p['orden']} · {p['calle'] or 's/n'} · rank {p['rank']} de la predicción congelada")
        pm.append(
            f"    <Placemark>\n      <name>{escape(p['ID_IDE'])}</name>\n      <description>{desc}</description>\n"
            f"      <ExtendedData><Data name=\"orden\"><value>{p['orden']}</value></Data>"
            f"<Data name=\"rank\"><value>{p['rank']}</value></Data></ExtendedData>\n"
            f"      <Point><coordinates>{p['lon']:.6f},{p['lat']:.6f},0</coordinates></Point>\n    </Placemark>"
        )
    coords = " ".join(f"{x:.6f},{y:.6f},0" for x, y in linea)
    pm.append(
        "    <Placemark>\n      <name>Ruta a pie desde el MUT</name>\n"
        "      <Style><LineStyle><color>ff0a3dff</color><width>3</width></LineStyle></Style>\n"
        f"      <LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString>\n    </Placemark>"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n'
        f"    <name>{escape(nombre)}</name>\n" + "\n".join(pm) + "\n  </Document>\n</kml>\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prediccion", default="data/validacion/prediccion_congelada.csv")
    ap.add_argument("--overpass", default="https://maps.mail.ru/osm/tools/overpass/api")
    a = ap.parse_args()

    import networkx as nx
    import osmnx as ox
    import pandas as pd

    pred = pd.read_csv(a.prediccion)
    meta_pred = json.loads(Path(a.prediccion).with_name("prediccion_congelada.meta.json").read_text(encoding="utf-8"))
    cx, cy = meta_pred["zona_mut"]["centro_lonlat"]
    radio = meta_pred["zona_mut"]["radio_m"]

    ruta_red = Path(f"cache/osm/red_walk_{cy:.6f}_{cx:.6f}_{radio + 400:.0f}m.graphml")
    if ruta_red.exists():
        G = ox.load_graphml(ruta_red)
    else:
        ox.settings.overpass_url = a.overpass
        print("Bajando red peatonal de OSM...")
        G = ox.graph_from_point((cy, cx), dist=radio + 400, network_type="walk", simplify=True)
        ruta_red.parent.mkdir(parents=True, exist_ok=True)
        ox.save_graphml(G, ruta_red)
    Gu = ox.convert.to_undirected(G)
    # Búsqueda de nodos en UTM (en WGS84 OSMnx pide scikit-learn)
    from pyproj import Transformer

    Gp = ox.project_graph(Gu, to_crs=UTM)
    a_utm = Transformer.from_crs(4326, UTM, always_xy=True)
    import numpy as np

    ids_nodos = list(Gp.nodes)
    nx_ = np.array([Gp.nodes[n]["x"] for n in ids_nodos])
    ny_ = np.array([Gp.nodes[n]["y"] for n in ids_nodos])

    salida_dir = Path(a.prediccion).parent
    resumen = {}
    for comuna, archivo in (("Providencia", "rejillas_mut_providencia.kml"), ("Las Condes", "rejillas_mut_las_condes.kml")):
        sub = pred[pred["comuna"] == comuna].reset_index(drop=True)
        lons = [cx] + sub["lon"].tolist()
        lats = [cy] + sub["lat"].tolist()
        xs, ys = a_utm.transform(lons, lats)
        nodos = [ids_nodos[int(np.argmin((nx_ - x) ** 2 + (ny_ - y) ** 2))] for x, y in zip(xs, ys)]
        n = len(nodos)
        D = [[0.0] * n for _ in range(n)]
        caminos = {}
        for i in range(n):
            dist, path = nx.single_source_dijkstra(Gu, nodos[i], weight="length")
            for j in range(n):
                D[i][j] = dist.get(nodos[j], float("inf"))
                caminos[(i, j)] = path.get(nodos[j], [nodos[i]])
        orden = ruta_abierta(D)
        linea = [(cx, cy)]
        for i in range(len(orden) - 1):
            for nd in caminos[(orden[i], orden[i + 1])][1:]:
                linea.append((Gu.nodes[nd]["x"], Gu.nodes[nd]["y"]))
            j = orden[i + 1] - 1
            linea.append((sub.loc[j, "lon"], sub.loc[j, "lat"]))
        puntos = []
        for k, idx in enumerate(orden[1:], start=1):
            r = sub.loc[idx - 1]
            puntos.append({"orden": k, "ID_IDE": r["ID_IDE"], "lon": float(r["lon"]), "lat": float(r["lat"]),
                           "calle": r["calle"] if isinstance(r["calle"], str) else None, "rank": int(r["rank"])})
        ruta = salida_dir / archivo
        ruta.write_text(kml(f"Rejillas zona MUT · {comuna}", puntos, linea), encoding="utf-8")
        resumen[comuna] = {"archivo": archivo, "rejillas": len(puntos), "largo_ruta_m": round(largo(orden, D), 1),
                           "orden": [p["ID_IDE"] for p in puntos], "sha256": sha256(ruta)}
        print(f"{comuna}: {len(puntos)} rejillas, ruta de {largo(orden, D) / 1000:.2f} km → {ruta}")

    meta = {
        "generado_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuente": {"prediccion": a.prediccion, "sha256": sha256(a.prediccion)},
        "inicio": {"lugar": "MUT", "centro_lonlat": [cx, cy], "confirmado": meta_pred["zona_mut"].get("centro_confirmado")},
        "metodo": "red peatonal OSM (walk), vecino más cercano + 2-opt, ruta abierta desde el MUT",
        "red": {"graphml": str(ruta_red), "sha256": sha256(ruta_red)},
        "comunas": resumen,
        "sin_comuna_exportada": pred[~pred["comuna"].isin(["Providencia", "Las Condes"])]["ID_IDE"].tolist(),
        "script": {"ruta": "pipeline/06_exportar_kml.py", "version": SCRIPT_VERSION, "sha256": sha256(__file__)},
    }
    (salida_dir / "rutas_mut.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
