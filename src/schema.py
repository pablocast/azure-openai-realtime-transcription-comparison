from __future__ import annotations

from typing import Any


ANAMNESE_SCHEMA_NAME = "anamnese_extract"


# ---------------------------------------------------------------------------
# JSON Schema
# ---------------------------------------------------------------------------
#
# Designed for Azure OpenAI Realtime structured output (``strict: true``):
#   - Every property listed in ``required``.
#   - ``additionalProperties: false`` on every object.
#   - Optional values modeled as nullable unions (e.g. ``["string", "null"]``).
#   - Cumulative array fields (alergias, medicamentos_en_uso, ...) are
#     replaced wholesale by the UI on each turn (see ANAMNESE_EXTRACT_PROMPT).
#
ANAMNESE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "identificacion",
        "motivo_consulta",
        "historia_enfermedad_actual",
        "antecedentes_personales",
        "antecedentes_familiares",
        "habitos_estilo_vida",
        "revision_sistemas",
        "observaciones_adicionales",
        "expectativas_plan",
    ],
    "properties": {
        # 1) Identificación
        "identificacion": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "nombre",
                "fecha_nacimiento",
                "edad",
                "telefono",
                "email",
                "direccion",
                "responsable_legal",
            ],
            "properties": {
                "nombre": {"type": ["string", "null"]},
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
                "telefono": {"type": ["string", "null"]},
                "email": {"type": ["string", "null"]},
                "direccion": {"type": ["string", "null"]},
                "responsable_legal": {"type": ["string", "null"]},
            },
        },
        # 2) Motivo de consulta
        "motivo_consulta": {"type": ["string", "null"]},
        # 3) Historia de la enfermedad actual
        "historia_enfermedad_actual": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "inicio",
                "evolucion",
                "localizacion",
                "intensidad_0_10",
                "duracion_frecuencia",
                "sintomas_asociados",
                "factores_mejora",
                "factores_empeoramiento",
                "tratamientos_previos",
                "impacto_rutina",
            ],
            "properties": {
                "inicio": {"type": ["string", "null"]},
                "evolucion": {"type": ["string", "null"]},
                "localizacion": {"type": ["string", "null"]},
                "intensidad_0_10": {
                    "type": ["integer", "null"],
                    "minimum": 0,
                    "maximum": 10,
                },
                "duracion_frecuencia": {"type": ["string", "null"]},
                "sintomas_asociados": {"type": ["string", "null"]},
                "factores_mejora": {"type": ["string", "null"]},
                "factores_empeoramiento": {"type": ["string", "null"]},
                "tratamientos_previos": {"type": ["string", "null"]},
                "impacto_rutina": {"type": ["string", "null"]},
            },
        },
        # 4) Antecedentes personales
        "antecedentes_personales": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "enfermedades_previas",
                "cirugias_hospitalizaciones",
                "alergias",
                "medicamentos_en_uso",
                "vacunas",
            ],
            "properties": {
                "enfermedades_previas": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "cirugias_hospitalizaciones": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "alergias": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "medicamentos_en_uso": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["nombre", "dosis", "horario"],
                        "properties": {
                            "nombre": {"type": "string"},
                            "dosis": {"type": ["string", "null"]},
                            "horario": {"type": ["string", "null"]},
                        },
                    },
                },
                "vacunas": {"type": ["string", "null"]},
            },
        },
        # 5) Antecedentes familiares
        "antecedentes_familiares": {"type": ["string", "null"]},
        # 6) Hábitos y estilo de vida
        "habitos_estilo_vida": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "sueno",
                "alimentacion_hidratacion",
                "actividad_fisica",
                "tabaquismo",
                "alcohol",
                "estres_psicosocial",
                "trabajo_rutina",
            ],
            "properties": {
                "sueno": {"type": ["string", "null"]},
                "alimentacion_hidratacion": {"type": ["string", "null"]},
                "actividad_fisica": {"type": ["string", "null"]},
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
                "estres_psicosocial": {"type": ["string", "null"]},
                "trabajo_rutina": {"type": ["string", "null"]},
            },
        },
        # 7) Revisión por sistemas
        "revision_sistemas": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "respiratorio",
                "cardiovascular",
                "gastrointestinal",
                "neurologico",
                "genitourinario",
                "otros",
            ],
            "properties": {
                "respiratorio": {"type": ["string", "null"]},
                "cardiovascular": {"type": ["string", "null"]},
                "gastrointestinal": {"type": ["string", "null"]},
                "neurologico": {"type": ["string", "null"]},
                "genitourinario": {"type": ["string", "null"]},
                "otros": {"type": ["string", "null"]},
            },
        },
        # 8) Observaciones adicionales: signos vitales y hallazgos al
        #    examen físico, como campos estructurados (cada valor es texto
        #    libre para preservar unidades, p.ej. "160/60", "80 lpm").
        "observaciones_adicionales": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "presion_arterial",
                "frecuencia_cardiaca",
                "frecuencia_respiratoria",
                "temperatura",
                "saturacion_oxigeno",
                "peso",
                "talla",
                "examen_fisico",
                "notas",
            ],
            "properties": {
                "presion_arterial": {
                    "type": ["string", "null"],
                    "description": "Sistólica/diastólica, p.ej. '120/80 mmHg'.",
                },
                "frecuencia_cardiaca": {
                    "type": ["string", "null"],
                    "description": "Latidos por minuto, p.ej. '78 lpm'.",
                },
                "frecuencia_respiratoria": {
                    "type": ["string", "null"],
                    "description": "Respiraciones por minuto, p.ej. '16 rpm'.",
                },
                "temperatura": {
                    "type": ["string", "null"],
                    "description": "Temperatura corporal, p.ej. '36.8 °C'.",
                },
                "saturacion_oxigeno": {
                    "type": ["string", "null"],
                    "description": "Saturación de oxígeno, p.ej. '98%'.",
                },
                "peso": {
                    "type": ["string", "null"],
                    "description": "Peso, p.ej. '72 kg'.",
                },
                "talla": {
                    "type": ["string", "null"],
                    "description": "Talla, p.ej. '170 cm'.",
                },
                "examen_fisico": {
                    "type": ["string", "null"],
                    "description": "Hallazgos relevantes al examen físico.",
                },
                "notas": {
                    "type": ["string", "null"],
                    "description": "Cualquier otra observación que no encaje en los campos anteriores.",
                },
            },
        },
        # 9) Expectativas y plan inicial
        "expectativas_plan": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "expectativas_paciente",
                "orientaciones_iniciales",
                "conducta_remisiones",
                "proximo_control",
            ],
            "properties": {
                "expectativas_paciente": {"type": ["string", "null"]},
                "orientaciones_iniciales": {"type": ["string", "null"]},
                "conducta_remisiones": {"type": ["string", "null"]},
                "proximo_control": {"type": ["string", "null"]},
            },
        },
    },
}


