from __future__ import annotations

from typing import Any


ANAMNESE_SCHEMA_NAME = "anamnese_extract"


# ---------------------------------------------------------------------------
# JSON Schema
# ---------------------------------------------------------------------------
#
# General-purpose anamnesis, valid for any adult patient (male or female).
# Designed for Azure OpenAI structured output (``strict: true``):
#   - Every property listed in ``required``.
#   - ``additionalProperties: false`` on every object.
#   - Optional values modeled as nullable unions (e.g. ``["string", "null"]``).
#   - Cumulative array fields (medicamentos_actuales, laboratorios, ...) are
#     appended + deduped by the UI on each turn.
#
ANAMNESE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "identificacion",
        "motivo_consulta",
        "enfermedad_actual",
        "antecedentes_patologicos",
        "medicamentos_actuales",
        "antecedentes_familiares",
        "habitos",
        "signos_vitales",
        "examen_fisico",
        "laboratorios",
        "plan",
    ],
    "properties": {
        # 1) Identificación
        "identificacion": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "nombre_completo",
                "documento_identidad",
                "fecha_nacimiento",
                "edad",
                "sexo",
                "lugar_nacimiento",
                "estado_civil",
                "nivel_educativo",
                "ocupacion",
                "eps_aseguradora",
                "celular",
                "email",
                "direccion",
                "acompanante",
            ],
            "properties": {
                "nombre_completo": {"type": ["string", "null"]},
                "documento_identidad": {"type": ["string", "null"]},
                "fecha_nacimiento": {
                    "type": ["string", "null"],
                    "description": (
                        "Formato YYYY-MM-DD cuando sea inequívoco; "
                        "si no, transcribir tal como el paciente lo dijo."
                    ),
                },
                "edad": {
                    "type": ["integer", "null"],
                    "minimum": 0,
                    "maximum": 130,
                },
                "sexo": {
                    "type": ["string", "null"],
                    "description": "masculino | femenino | otro",
                },
                "lugar_nacimiento": {"type": ["string", "null"]},
                "estado_civil": {"type": ["string", "null"]},
                "nivel_educativo": {"type": ["string", "null"]},
                "ocupacion": {"type": ["string", "null"]},
                "eps_aseguradora": {"type": ["string", "null"]},
                "celular": {"type": ["string", "null"]},
                "email": {"type": ["string", "null"]},
                "direccion": {"type": ["string", "null"]},
                "acompanante": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["nombre", "parentesco", "telefono"],
                    "properties": {
                        "nombre": {"type": ["string", "null"]},
                        "parentesco": {"type": ["string", "null"]},
                        "telefono": {"type": ["string", "null"]},
                    },
                },
            },
        },
        # 2) Motivo de consulta
        "motivo_consulta": {"type": ["string", "null"]},
        # 3) Enfermedad actual
        "enfermedad_actual": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "resumen",
                "tiempo_evolucion",
                "control_previo",
                "sintomas_actuales",
                "adherencia_tratamiento",
            ],
            "properties": {
                "resumen": {"type": ["string", "null"]},
                "tiempo_evolucion": {"type": ["string", "null"]},
                "control_previo": {"type": ["string", "null"]},
                "sintomas_actuales": {"type": ["string", "null"]},
                "adherencia_tratamiento": {"type": ["string", "null"]},
            },
        },
        # 4) Antecedentes patológicos
        "antecedentes_patologicos": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "enfermedades_cronicas",
                "gastrointestinales",
                "cirugias",
                "hospitalizaciones",
                "alergias",
            ],
            "properties": {
                "enfermedades_cronicas": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "gastrointestinales": {"type": ["string", "null"]},
                "cirugias": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "hospitalizaciones": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "alergias": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
        },
        # 5) Medicamentos actuales
        "medicamentos_actuales": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["nombre", "dosis", "frecuencia", "indicacion"],
                "properties": {
                    "nombre": {"type": "string"},
                    "dosis": {"type": ["string", "null"]},
                    "frecuencia": {"type": ["string", "null"]},
                    "indicacion": {"type": ["string", "null"]},
                },
            },
        },
        # 6) Antecedentes familiares
        "antecedentes_familiares": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["parentesco", "condicion"],
                "properties": {
                    "parentesco": {"type": "string"},
                    "condicion": {"type": "string"},
                },
            },
        },
        # 7) Hábitos y estilo de vida
        "habitos": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "tabaquismo",
                "alcohol",
                "alimentacion",
                "actividad_fisica",
                "suplementos",
            ],
            "properties": {
                "tabaquismo": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["consume", "detalle"],
                    "properties": {
                        "consume": {"type": ["boolean", "null"]},
                        "detalle": {"type": ["string", "null"]},
                    },
                },
                "alcohol": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["consume", "detalle"],
                    "properties": {
                        "consume": {"type": ["boolean", "null"]},
                        "detalle": {"type": ["string", "null"]},
                    },
                },
                "alimentacion": {"type": ["string", "null"]},
                "actividad_fisica": {"type": ["string", "null"]},
                "suplementos": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
        },
        # 8) Signos vitales (cada valor es texto libre para preservar unidades,
        #    p.ej. "125/85 mmHg", "75 lpm").
        "signos_vitales": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "presion_arterial",
                "frecuencia_cardiaca",
                "frecuencia_respiratoria",
                "temperatura",
                "saturacion_oxigeno",
                "peso_kg",
                "talla_cm",
                "perimetro_abdominal_cm",
            ],
            "properties": {
                "presion_arterial": {
                    "type": ["string", "null"],
                    "description": "Sistólica/diastólica, p.ej. '125/85 mmHg'.",
                },
                "frecuencia_cardiaca": {
                    "type": ["string", "null"],
                    "description": "Latidos por minuto, p.ej. '75 lpm'.",
                },
                "frecuencia_respiratoria": {
                    "type": ["string", "null"],
                    "description": "Respiraciones por minuto, p.ej. '16 rpm'.",
                },
                "temperatura": {
                    "type": ["string", "null"],
                    "description": "Temperatura corporal, p.ej. '37 °C'.",
                },
                "saturacion_oxigeno": {
                    "type": ["string", "null"],
                    "description": "Saturación de oxígeno, p.ej. '95%'.",
                },
                "peso_kg": {
                    "type": ["string", "null"],
                    "description": "Peso, p.ej. '53 kg'.",
                },
                "talla_cm": {
                    "type": ["string", "null"],
                    "description": "Talla, p.ej. '160 cm'.",
                },
                "perimetro_abdominal_cm": {
                    "type": ["string", "null"],
                    "description": "Perímetro abdominal, p.ej. '84 cm'.",
                },
            },
        },
        # 9) Examen físico
        "examen_fisico": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "estado_general",
                "cardiopulmonar",
                "abdomen",
                "renal_ppl",
                "neurologico_pulsos",
                "hallazgos_relevantes",
            ],
            "properties": {
                "estado_general": {"type": ["string", "null"]},
                "cardiopulmonar": {"type": ["string", "null"]},
                "abdomen": {"type": ["string", "null"]},
                "renal_ppl": {
                    "type": ["string", "null"],
                    "description": "Puño-percusión lumbar / hallazgos renales.",
                },
                "neurologico_pulsos": {"type": ["string", "null"]},
                "hallazgos_relevantes": {"type": ["string", "null"]},
            },
        },
        # 10) Laboratorios y exámenes
        "laboratorios": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["prueba", "valor", "unidad", "interpretacion"],
                "properties": {
                    "prueba": {"type": "string"},
                    "valor": {"type": "string"},
                    "unidad": {"type": ["string", "null"]},
                    "interpretacion": {"type": ["string", "null"]},
                },
            },
        },
        # 11) Plan (autoría del médico)
        "plan": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "diagnosticos",
                "ordenes_examenes",
                "remisiones",
                "ajuste_medicacion",
                "recomendaciones",
                "proximo_control",
            ],
            "properties": {
                "diagnosticos": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "ordenes_examenes": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "remisiones": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "ajuste_medicacion": {"type": ["string", "null"]},
                "recomendaciones": {"type": ["string", "null"]},
                "proximo_control": {"type": ["string", "null"]},
            },
        },
    },
}


