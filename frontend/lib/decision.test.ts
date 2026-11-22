// Pruebas de los apoyos de decisión de la central y la cuadrilla. Se ejecuta con `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  equipoSugerido,
  fotoParaEquipo,
  evidenciaVigente,
  motivosCalculados,
  ordenPins,
  paradasPorSumidero,
  textoEvidencia,
  type PinOrdenable,
} from "./decision.ts";

const AHORA = Date.parse("2026-11-22T12:00:00Z");
const hace = (h: number) => new Date(AHORA - h * 3_600_000).toISOString();
const obs = (h: number, clasificacion: unknown, extra: Record<string, unknown> = {}) => ({
  id: `o${h}`,
  fuente: "vecino",
  tipo: "foto_rejilla",
  tiene_foto: true,
  tiene_texto: false,
  ts: hace(h),
  clasificacion,
  ...extra,
});

test("la señal vigente conserva el hidrojet aunque 20 textos desplacen la foto de la ficha", () => {
  const observaciones = Array.from({ length: 20 }, () => obs(1, { tipo: "basura" }, { tipo: "texto" }));
  const foto = fotoParaEquipo({ observaciones, senales: [{
    observation_id: "foto", senal: "rejilla", tipo_observacion: "foto_rejilla", ts: hace(24),
    fuente: "vecino", valor: "tapada", material: ["sedimento"], confianza: "alta",
    factor_confianza: 1, aplica_en: ["durante"], usada: true, is_simulated: false,
  }] }, AHORA);
  assert.equal(equipoSugerido(foto), "hidrojet");
});

test("el texto conserva incidente, gravedad y riesgo, y solo marca niveles de agua observados", () => {
  const clasificacion = { tipo: "arbol_caido", gravedad: "alta", personas_en_riesgo: true };
  for (const nivel of ["sin_agua", "no_evaluable", "hasta_vereda"]) {
    const e = evidenciaVigente([obs(1, { ...clasificacion, nivel_agua: nivel }, { tipo: "texto" })], AHORA);
    assert.ok(e);
    assert.equal(e.nivelAgua, nivel === "hasta_vereda" ? nivel : null);
    const agua = nivel === "hasta_vereda" ? " · agua hasta la vereda" : "";
    assert.equal(textoEvidencia(e), "Reporte de texto: árbol caído · gravedad alta · personas en riesgo" + agua);
  }
});

test("los pines de mayor prioridad se dibujan al final, encima de los demás", () => {
  const pins: PinOrdenable[] = [
    { rank: 1, prio: "alta" },
    { rank: 40, prio: "baja" },
    { rank: 2, prio: "alta" },
    { rank: 12, prio: "media" },
    { rank: 3, prio: "alta", faded: true },
  ];
  const orden = [...pins].sort(ordenPins).map((p) => p.rank);
  assert.deepEqual(orden, [3, 40, 12, 2, 1]);
});

test("el punto anegado queda sobre todos los pines", () => {
  const orden = [{ rank: "≋", prio: "anegado" as const }, { rank: 1, prio: "alta" as const }].sort(ordenPins);
  assert.equal(orden.at(-1)?.prio, "anegado");
});

test("los motivos calculados muestran las variables que más suman, sin las nulas", () => {
  assert.deepEqual(motivosCalculados({ pendiente: 0.14, dias_sin_limpieza: 0.09, arboles: 0, feria: 0.2 }), [
    "feria cercana",
    "arrastre por pendiente",
  ]);
  assert.deepEqual(motivosCalculados(null), []);
});

test("una foto no evaluable deja vigente la observación anterior", () => {
  const e = evidenciaVigente(
    [obs(1, { evaluable: false }), obs(5, { evaluable: true, rejilla: "tapada", material: ["hojas"] })],
    AHORA,
  );
  assert.equal(e?.rejilla, "tapada");
  assert.deepEqual(e?.material, ["hojas"]);
});

test("una observación vencida no cuenta como evidencia", () => {
  assert.equal(evidenciaVigente([obs(80, { evaluable: true, rejilla: "tapada" })], AHORA), null);
  assert.equal(evidenciaVigente([], AHORA), null);
});

test("el agua observada vence a las 6 horas; una obstrucción, a las 72", () => {
  const agua = (h: number) => obs(h, { evaluable: true, nivel_agua: "hasta_vereda" }, { tipo: "foto_agua" });
  assert.equal(evidenciaVigente([agua(5)], AHORA)?.nivelAgua, "hasta_vereda");
  assert.equal(evidenciaVigente([agua(7)], AHORA), null);
  // El agua vencida no tapa una foto de rejilla anterior que sigue vigente
  assert.equal(evidenciaVigente([agua(7), obs(30, { evaluable: true, rejilla: "tapada" })], AHORA)?.rejilla, "tapada");
});

test("el filtro por tipo encuentra la última foto de rejilla aunque haya agua más reciente", () => {
  const lista = [
    obs(1, { evaluable: true, nivel_agua: "cuneta" }, { tipo: "foto_agua" }),
    obs(3, { evaluable: true, rejilla: "tapada", material: ["sedimento"] }),
  ];
  assert.equal(evidenciaVigente(lista, AHORA)?.tipo, "foto_agua");
  assert.equal(equipoSugerido(evidenciaVigente(lista, AHORA, "foto_rejilla")), "hidrojet");
});

test("la evidencia conserva si es simulada y se describe en texto", () => {
  const e = evidenciaVigente([obs(2, { evaluable: true, rejilla: "parcial", material: ["sedimento"] }, { is_simulated: true })], AHORA);
  assert.equal(e?.simulada, true);
  assert.equal(textoEvidencia(e!), "Foto de vecino: rejilla parcialmente tapada (sedimento)");
});

test("el equipo sigue la regla del despacho: sedimento pide hidrojet", () => {
  const conSedimento = evidenciaVigente([obs(1, { evaluable: true, rejilla: "tapada", material: ["hojas", "sedimento"] })], AHORA);
  const conHojas = evidenciaVigente([obs(1, { evaluable: true, rejilla: "tapada", material: ["hojas"] })], AHORA);
  const agua = evidenciaVigente([obs(1, { evaluable: true, nivel_agua: "cuneta" }, { tipo: "foto_agua" })], AHORA);
  assert.equal(equipoSugerido(conSedimento), "hidrojet");
  assert.equal(equipoSugerido(conHojas), "manual");
  assert.equal(equipoSugerido(agua), null);
  assert.equal(equipoSugerido(null), null);
});

test("las paradas en ruta se numeran desde la siguiente", () => {
  const m = paradasPorSumidero([
    { sumidero_id: "A", estado: "en_camino" },
    { sumidero_id: null, estado: "pendiente" },
    { sumidero_id: "B", estado: "pendiente" },
  ]);
  assert.deepEqual(m.get("A"), { orden: 1, estado: "en_camino" });
  assert.deepEqual(m.get("B"), { orden: 3, estado: "pendiente" });
  assert.equal(m.has("C"), false);
});
