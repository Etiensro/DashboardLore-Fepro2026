"""
╔══════════════════════════════════════════════════════════════╗
║         LORE — Panel Docente  ·  app.py  v1.0               ║
║         Backend Flask · Python 3                             ║
╚══════════════════════════════════════════════════════════════╝

Rutas implementadas:
  GET  /           → redirige a /login
  GET  /login      → formulario de autenticación
  POST /login      → mock auth → redirige a /setup
  GET  /setup      → formulario de configuración de sala
  POST /setup      → procesa PDF + genera preguntas + guarda en Firestore
  GET  /sala/<cod> → pantalla de código de sala
  GET  /dashboard  → panel de métricas (carga index.html del frontend)

Dependencias:  flask, PyPDF2, firebase-admin
"""

import json
import os
import random
import string
import time
from dotenv import load_dotenv

# Cargar variables de entorno desde .env
load_dotenv()

from groq import Groq
from flask import (Flask, render_template, request,
                   redirect, url_for, session, flash, jsonify)
from flask_cors import CORS

# ── Firebase Admin SDK ─────────────────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore

# ──────────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)  # Habilitar soporte de CORS para peticiones externas / Godot
app.secret_key = os.environ.get("FLASK_SECRET", "lore-dev-secret-2024-change-me")

# ── Inicializar Firebase Admin ─────────────────────────────────────────────────
# Coloca tu archivo serviceAccountKey.json en la raíz del proyecto y
# reemplaza la ruta si la guardas en otro lugar.
# Para omitir Firebase en desarrollo, establece la variable de entorno:
#   set LORE_SKIP_FIREBASE=1
_firebase_initialized = False
db = None

def init_firebase():
    global _firebase_initialized, db
    if _firebase_initialized:
        return
    if os.environ.get("LORE_SKIP_FIREBASE"):
        print("[LORE] Firebase Admin omitido (LORE_SKIP_FIREBASE=1).")
        return

    # ── Opción 1: JSON completo en variable de entorno (Render / Web / Produccion) ──
    creds_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")
    if creds_json:
        try:
            creds_dict = json.loads(creds_json)
            cred = credentials.Certificate(creds_dict)
            firebase_admin.initialize_app(cred)
            db = firestore.client()
            _firebase_initialized = True
            print("[LORE] Firebase Admin inicializado desde variable de entorno FIREBASE_CREDENTIALS_JSON.")
            return
        except Exception as exc:
            print(f"[LORE] Error al inicializar Firebase desde variable de entorno: {exc}")

    # ── Opción 2: Archivo serviceAccountKey.json local ──────────
    key_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
    if not os.path.exists(key_path):
        print(
            "[LORE] ADVERTENCIA: No se encontró serviceAccountKey.json ni FIREBASE_CREDENTIALS_JSON.\n"
            "       Firestore no estará disponible.\n"
            "       En Render: agrega la variable de entorno FIREBASE_CREDENTIALS_JSON con el JSON completo\n"
            "       de tu cuenta de servicio de Firebase."
        )
        return
    try:
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        _firebase_initialized = True
        print("[LORE] Firebase Admin inicializado desde serviceAccountKey.json.")
    except Exception as exc:
        print(f"[LORE] Error al inicializar Firebase desde archivo: {exc}")

init_firebase()


# ── Credenciales mock de login ─────────────────────────────────────────────────
# En producción, valida contra tu base de datos o Firebase Auth.
MOCK_USERS = {
    "docente":  "lore2024",
    "admin":    "admin123",
}


# ══════════════════════════════════════════════════════════════════════════════
# UTILIDADES
# ══════════════════════════════════════════════════════════════════════════════

def generate_room_code(length: int = 5) -> str:
    """Genera un código alfanumérico en MAYÚSCULAS de `length` caracteres."""
    chars = string.ascii_uppercase + string.digits
    return "".join(random.choices(chars, k=length))


def extract_pdf_text(file_obj) -> str:
    """Extrae todo el texto de un PDF usando PyPDF2."""
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader(file_obj)
        text_parts = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text_parts.append(t)
        return "\n".join(text_parts).strip()
    except Exception as exc:
        print(f"[LORE] Error al leer PDF: {exc}")
        return ""


def get_mock_questions(materia: str, tema: str, text: str = "") -> dict:
    """Genera datos de prueba de respaldo si la API de IA no está disponible."""
    snippet = text[:120] if text else f"conceptos de {tema}"
    cerradas = [
        {
            "pregunta": f"¿Cuál es el concepto principal de '{tema}' según el temario?",
            "opciones": {"A": "Opción A", "B": "Opción B", "C": f"{tema}", "D": "Opción D"},
            "correcta": "C",
        },
        {
            "pregunta": f"¿Qué disciplina abarca principalmente {materia}?",
            "opciones": {"A": "Historia", "B": f"{materia}", "C": "Geografía", "D": "Arte"},
            "correcta": "B",
        },
        {
            "pregunta": f"¿Cuál de las siguientes NO pertenece a {tema}?",
            "opciones": {"A": "Elemento 1", "B": "Elemento 2", "C": "Elemento 3", "D": "Elemento externo"},
            "correcta": "D",
        },
        {
            "pregunta": "¿Qué caracteriza a una definición formal en este campo?",
            "opciones": {"A": "Precisión", "B": "Ambigüedad", "C": "Longitud", "D": "Ninguna"},
            "correcta": "A",
        },
        {
            "pregunta": f"Según el texto, ¿cuándo aplica el principio fundamental de {tema}?",
            "opciones": {"A": "Siempre", "B": "Nunca", "C": "Sólo en casos especiales", "D": "Depende del contexto"},
            "correcta": "D",
        },
    ]

    abiertas = [
        {"pregunta": f"¿Cuál es la palabra clave que define {tema}?",       "respuesta": tema.split()[0].upper() if tema else "TEMA"},
        {"pregunta": "¿Cómo se llama el proceso principal descrito?",         "respuesta": "PROCESO"},
        {"pregunta": "¿Qué término se usa para el elemento fundamental?",     "respuesta": "BASE"},
        {"pregunta": "¿En qué unidad se mide el concepto central?",           "respuesta": "UNIDAD"},
        {"pregunta": "¿Cuál es el resultado esperado del método descrito?",   "respuesta": "RESULTADO"},
    ]

    return {
        "materia":        materia,
        "tema":           tema,
        "extracto_texto": snippet,
        "cerradas":       cerradas,
        "abiertas":       abiertas,
    }


def generate_dynamic_telemetry(conceptos: list) -> list:
    """
    Genera un conjunto de datos simulados de telemetría estudiantil
    utilizando las palabras clave y conceptos reales extraídos del PDF del profesor.
    """
    if not conceptos or len(conceptos) < 3:
        conceptos = ["PROMEDIO", "MEDIANA", "MODA", "MUESTRA", "POBLACIÓN", "RANGO"]
    
    c = [str(item).strip().upper() for item in conceptos if str(item).strip()]
    while len(c) < 5:
        c.append(f"CONCEPTO_{len(c)+1}")
        
    return [
        {
            "alumno_id": "ALUMNO_101",
            "estado_final": "victoria",
            "historial_aciertos": [c[0], c[1], c[2], c[3]],
            "historial_errores": [c[4]] if len(c) > 4 else [],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_102",
            "estado_final": "victoria",
            "historial_aciertos": [c[0], c[1], c[3], c[4] if len(c)>4 else c[2]],
            "historial_errores": [c[2]],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_103",
            "estado_final": "derrota",
            "historial_aciertos": [c[0]],
            "historial_errores": [c[1], c[2], c[3]],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_104",
            "estado_final": "victoria",
            "historial_aciertos": [c[0], c[1], c[2], c[3], c[4] if len(c)>4 else c[0]],
            "historial_errores": [],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_105",
            "estado_final": "derrota",
            "historial_aciertos": [c[2]],
            "historial_errores": [c[0], c[1], c[3]],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_106",
            "estado_final": "victoria",
            "historial_aciertos": [c[0], c[2], c[3]],
            "historial_errores": [c[1]],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_107",
            "estado_final": "victoria",
            "historial_aciertos": [c[0], c[1], c[2]],
            "historial_errores": [c[3]],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_108",
            "estado_final": "derrota",
            "historial_aciertos": [c[3]],
            "historial_errores": [c[0], c[1]],
            "total_disparos": 4
        }
    ]


def generate_questions(text: str, materia: str, tema: str) -> dict:
    """
    Genera acertijos y niveles para el Escape Room usando Groq AI a partir del PDF subido.
    Aplica protección de tokens (máximo 3000 caracteres) y pausas anti-rate-limit.
    """

    groq_key = os.environ.get("GROQ_API_KEY")
    
    if groq_key:
        try:
            client = Groq(api_key=groq_key)
            
            # PROTECCIÓN DE TOKENS: Cortamos el texto a los primeros 3000 caracteres
            # (~700 tokens por petición, súper seguro contra límites de consumo y tasa)
            texto_resumido = text[:3000] if text else ""
            contexto_pdf = f"BASA TUS PREGUNTAS ESTRICTAMENTE EN EL SIGUIENTE TEXTO DEL PDF DEL PROFESOR:\n{texto_resumido}\n\n" if texto_resumido else ""
            
            print(f"[LORE] Generando acertijos con Groq AI para '{materia}' - '{tema}' (Protección de tokens activa: {len(texto_resumido)} chars)...")
            
            # --- PETICIÓN NIVEL 1 (escena_computadora + escena_garra) ---
            prompt_n1 = f"""
            {contexto_pdf}
            Eres el motor lógico de un Escape Room educativo en Godot. 
            Genera 5 preguntas de texto abierto y 5 de opción múltiple sobre la materia '{materia}' y el tema '{tema}'.
            
            REGLAS CRÍTICAS PARA PREGUNTAS DE TEXTO ABIERTO (escena_computadora):
            1. La 'respuesta_correcta' DEBE SER EXACTAMENTE MAXIMO TRES (3) PALABRAS o un número. Cero excepciones.
            2. Prohibido usar frases, oraciones o artículos (el, la, los, las).
            3. Formula la pregunta para obligar una respuesta exacta de 1 palabra.

            Responde ÚNICAMENTE con un objeto JSON válido, sin bloques markdown.
            Estructura:
            {{
              "metadata_nivel": {{
                "materia": "{materia}",
                "tema": "{tema}",
                "limite_errores_cambio": 3
              }},
              "escena_computadora": [
                {{
                  "id": "comp_01",
                  "tipo_input": "texto_abierto",
                  "pregunta_texto": "¿Pregunta de respuesta 1 palabra?",
                  "respuesta_correcta": "PALABRA"
                }}
              ],
              "escena_garra": [
                {{
                  "id": "garra_01",
                  "tipo_input": "opcion_multiple",
                  "pregunta_texto": "¿Pregunta de opción múltiple?",
                  "opciones": ["Opción Correcta", "Distractor 1", "Distractor 2", "Distractor 3"],
                  "respuesta_correcta": "Opción Correcta"
                }}
              ]
            }}
            """
            
            res_n1 = client.chat.completions.create(
                messages=[{"role": "system", "content": prompt_n1}],
                model="openai/gpt-oss-20b",
                temperature=0.4,
                response_format={"type": "json_object"}
            )
            n1_data = json.loads(res_n1.choices[0].message.content)
            
            # Formatear preguntas para la vista del docente (/revisar)
            cerradas = []
            for item in n1_data.get("escena_garra", []):
                opts = item.get("opciones", [])
                corr = item.get("respuesta_correcta", "")
                if not isinstance(opts, list) or len(opts) < 4:
                    opts = (list(opts) + ["Opción A", "Opción B", "Opción C", "Opción D"])[:4]
                
                letra_correcta = "A"
                for idx, o in enumerate(opts):
                    if str(o).strip().lower() == str(corr).strip().lower():
                        letra_correcta = ["A", "B", "C", "D"][idx]
                        break
                
                cerradas.append({
                    "pregunta": item.get("pregunta_texto", ""),
                    "opciones": {"A": str(opts[0]), "B": str(opts[1]), "C": str(opts[2]), "D": str(opts[3])},
                    "correcta": letra_correcta
                })
            
            abiertas = []
            for item in n1_data.get("escena_computadora", []):
                abiertas.append({
                    "pregunta": item.get("pregunta_texto", ""),
                    "respuesta": str(item.get("respuesta_correcta", "")).strip().upper()
                })
            
            # PAUSA DE SEGURIDAD / PROTECCIÓN DE RATE LIMIT
            time.sleep(2)
            
            # --- PETICIÓN NIVELES 2, 3 Y 4 ---
            prompt_n2_n3_n4 = f"""
            {contexto_pdf}
            Eres el motor lógico de un Escape Room educativo en Godot. 
            Genera los acertijos JSON para Nivel 2, Nivel 3 y Nivel 4 sobre '{materia}' y '{tema}'.
            
            Responde ÚNICAMENTE con un objeto JSON válido con esta estructura:
            {{
              "nivel_2": {{
                "carrito_fase": [
                  {{"texto": "¿Afirmación sobre el tema?", "respuesta": true}}
                ],
                "tuneles_fase": [
                  {{
                    "pregunta": "¿Pregunta de opción múltiple para túnel?",
                    "opciones": {{"izquierda": "Distractor 1", "frente": "Opción Correcta", "derecha": "Distractor 2"}},
                    "correcta": "frente"
                  }}
                ]
              }},
              "nivel_3": {{
                "laser_puzzles": [
                  {{
                    "materia": "{materia}",
                    "pregunta": "¿PREGUNTA EN MAYÚSCULAS?",
                    "opciones": [
                      {{"texto": "RESPUESTA CORRECTA", "correcta": true}},
                      {{"texto": "DISTRACTOR 1", "correcta": false}},
                      {{"texto": "DISTRACTOR 2", "correcta": false}}
                    ]
                  }}
                ],
                "tema_1": {{
                  "materia": "{materia}",
                  "pregunta": "¿Pregunta numérica?",
                  "tipo": "numeros",
                  "objetivo": "100"
                }},
                "tema_2": {{
                  "materia": "{materia}",
                  "pregunta": "¿Enigma de una sola palabra clave?",
                  "tipo": "letras",
                  "objetivo": "PALABRA"
                }}
              }},
              "nivel_4": {{
                "preguntas": [
                  {{
                    "pregunta": "¿Pregunta final de evaluación?",
                    "opciones": ["Distractor 1", "Respuesta Correcta", "Distractor 2", "Distractor 3"],
                    "indice_correcto": 1
                  }}
                ]
              }}
            }}
            """
            
            res_resto = client.chat.completions.create(
                messages=[{"role": "system", "content": prompt_n2_n3_n4}],
                model="openai/gpt-oss-20b",
                temperature=0.4,
                response_format={"type": "json_object"}
            )
            resto_data = json.loads(res_resto.choices[0].message.content)
            
            conceptos_extraidos = []
            for a in abiertas:
                ans = str(a.get("respuesta", "")).strip().upper()
                if ans and ans not in conceptos_extraidos and len(ans) > 1:
                    conceptos_extraidos.append(ans)
            
            if len(conceptos_extraidos) < 5 and tema:
                for word in tema.upper().split():
                    w = word.strip().upper()
                    if len(w) > 2 and w not in conceptos_extraidos:
                        conceptos_extraidos.append(w)

            telemetria_simulada = generate_dynamic_telemetry(conceptos_extraidos)

            
            print("[LORE] ¡Preguntas y telemetría demostrativa generadas exitosamente!")
            return {
                "materia":             materia,
                "tema":                tema,
                "extracto_texto":      texto_resumido[:120] if texto_resumido else f"conceptos de {tema}",
                "cerradas":            cerradas if cerradas else get_mock_questions(materia, tema, text)["cerradas"],
                "abiertas":            abiertas if abiertas else get_mock_questions(materia, tema, text)["abiertas"],
                "nivel_1":             n1_data,
                "nivel_2":             resto_data.get("nivel_2", {}),
                "nivel_3":             resto_data.get("nivel_3", {}),
                "nivel_4":             resto_data.get("nivel_4", {}),
                "generado_con_ia":     True,
                "telemetria_simulada": telemetria_simulada,
            }
            
        except Exception as exc:
            print(f"[LORE] Error al llamar a Groq AI ({exc}). Usando respaldo simulado.")
    
    # Fallback si falla la llamada
    mock_res = get_mock_questions(materia, tema, text)
    mock_res["generado_con_ia"] = False
    mock_res["telemetria_simulada"] = generate_dynamic_telemetry(["PROMEDIO", "MEDIANA", "MODA", "MUESTRA", "POBLACIÓN"])
    return mock_res





def login_required(f):
    """Decorador simple de sesion."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            flash("Debes iniciar sesion para acceder a esta seccion.", "warning")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


# ══════════════════════════════════════════════════════════════════════════════
# RUTAS
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("logged_in"):
        return redirect(url_for("setup"))
    error = None
    if request.method == "POST":
        usuario  = request.form.get("usuario", "").strip()
        password = request.form.get("password", "").strip()
        if MOCK_USERS.get(usuario) == password:
            session["logged_in"] = True
            session["usuario"]   = usuario
            return redirect(url_for("setup"))
        else:
            error = "Usuario o contrasena incorrectos. Intenta de nuevo."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/setup", methods=["GET", "POST"])
@login_required
def setup():
    if request.method == "POST":
        materia  = request.form.get("materia", "").strip()
        tema     = request.form.get("tema",    "").strip()
        pdf_file = request.files.get("temario")

        if not materia or not tema:
            flash("Por favor ingresa la materia y el tema.", "error")
            return render_template("setup.html")
        if not pdf_file or pdf_file.filename == "":
            flash("Por favor sube un archivo PDF con el temario.", "error")
            return render_template("setup.html")
        if not pdf_file.filename.lower().endswith(".pdf"):
            flash("El archivo debe ser un PDF.", "error")
            return render_template("setup.html")

        # 1. Extraer texto del PDF
        pdf_text  = extract_pdf_text(pdf_file.stream)

        # 2. Generar preguntas (mock / LLM)
        questions = generate_questions(pdf_text, materia, tema)

        # 3. Generar código de sala
        codigo = generate_room_code(5)

        # 4. Guardar en sesión
        session["sala_pendiente"] = {
            "codigo":    codigo,
            "materia":   materia,
            "tema":      tema,
            "preguntas": questions,
        }
        if "telemetria_simulada" in questions:
            session["demo_telemetria"] = questions["telemetria_simulada"]

        # 5. Redirigir a la vista de revisión
        return redirect(url_for("revisar"))

    return render_template("setup.html")


# ── /revisar ─────────────────────────────────────────────────────────────────
@app.route("/revisar")
@login_required
def revisar():
    """Muestra las preguntas generadas para que el profesor las revise."""
    sala = session.get("sala_pendiente")
    if not sala:
        flash("No hay una sala pendiente de revisión. Genera una nueva.", "warning")
        return redirect(url_for("setup"))
    return render_template("review.html",
        codigo    = sala["codigo"],
        materia   = sala["materia"],
        tema      = sala["tema"],
        preguntas = sala["preguntas"],
    )


# ── /confirmar ───────────────────────────────────────────────────────────────
@app.route("/confirmar", methods=["POST"])
@login_required
def confirmar():
    """El profesor confirmó las preguntas: guarda en Firestore y activa la sala."""
    sala = session.pop("sala_pendiente", None)
    if not sala:
        flash("Sesión expirada. Por favor genera la sala de nuevo.", "error")
        return redirect(url_for("setup"))

    codigo    = sala["codigo"]
    materia   = sala["materia"]
    tema      = sala["tema"]
    questions = sala["preguntas"]

    if db:
        try:
            sala_doc = {
                "codigo":     codigo,
                "materia":    materia,
                "tema":       tema,
                "preguntas":  questions,
                "creado_por": session.get("usuario", "desconocido"),
                "activa":     True,
                "timestamp":  firestore.SERVER_TIMESTAMP,
            }
            db.collection("salas_activas").document(codigo).set(sala_doc)
            print(f"[LORE] Sala '{codigo}' confirmada y guardada en Firestore.")

            # ── Guardar preguntas individuales en colección 'preguntas' ──────────
            batch = db.batch()

            # Preguntas cerradas (opción múltiple)
            for idx, q in enumerate(questions.get("cerradas", []), start=1):
                doc_ref = db.collection("preguntas").document(f"{codigo}_cerrada_{idx:02d}")
                batch.set(doc_ref, {
                    "codigo_sala":  codigo,
                    "materia":      materia,
                    "tema":         tema,
                    "tipo":         "cerrada",
                    "numero":       idx,
                    "pregunta":     q.get("pregunta", ""),
                    "opciones":     q.get("opciones", {}),
                    "correcta":     q.get("correcta", ""),
                    "timestamp":    firestore.SERVER_TIMESTAMP,
                })

            # Preguntas abiertas (texto libre)
            for idx, q in enumerate(questions.get("abiertas", []), start=1):
                doc_ref = db.collection("preguntas").document(f"{codigo}_abierta_{idx:02d}")
                batch.set(doc_ref, {
                    "codigo_sala":  codigo,
                    "materia":      materia,
                    "tema":         tema,
                    "tipo":         "abierta",
                    "numero":       idx,
                    "pregunta":     q.get("pregunta", ""),
                    "respuesta":    q.get("respuesta", ""),
                    "timestamp":    firestore.SERVER_TIMESTAMP,
                })

            batch.commit()
            print(f"[LORE] {len(questions.get('cerradas', []))} preguntas cerradas y "
                  f"{len(questions.get('abiertas', []))} abiertas guardadas en colección 'preguntas' "
                  f"con codigo_sala='{codigo}'.")

            # Guardar telemetría simulada adaptada al PDF en Firestore
            if "telemetria_simulada" in questions:
                tel_batch = db.batch()
                for student in questions["telemetria_simulada"]:
                    doc_ref = db.collection("telemetria_resultados").document(student["alumno_id"])
                    s_data = dict(student)
                    s_data["timestamp"] = firestore.SERVER_TIMESTAMP
                    tel_batch.set(doc_ref, s_data)
                tel_batch.commit()
                print("[LORE] Telemetría simulada del PDF sincronizada en Firestore.")

        except Exception as exc:
            print(f"[LORE] Error Firestore: {exc}")
            flash(f"Advertencia: sala confirmada pero no guardada en Firestore ({exc}).", "warning")
    else:
        print(f"[LORE] Firestore no disponible. Sala '{codigo}' confirmada solo en memoria.")
        flash("Advertencia: Firestore no configurado. El codigo es solo local.", "warning")

    return redirect(url_for("sala", codigo=codigo))


@app.route("/sala/<codigo>")
@login_required
def sala(codigo: str):
    codigo = codigo.upper()
    return render_template("sala.html", codigo=codigo)


@app.route("/dashboard")
@login_required
def dashboard():
    demo_data = session.get("demo_telemetria")
    return render_template("dashboard.html", demo_data=demo_data)



# ── /upload-pdf (API pública para Godot / clientes externos) ───────────────────
@app.route('/upload-pdf', methods=['POST'])
def upload_pdf_api():
    """
    Endpoint de API para subir PDFs y generar niveles directamente (ej. desde Godot o cliente externo).
    Soporta la clave 'file' o 'temario' en la petición.
    """
    materia = request.form.get('materia', 'Sin materia').strip()
    tema = request.form.get('tema', 'Sin tema').strip()
    
    pdf_file = request.files.get('file') or request.files.get('temario')
    if not pdf_file or pdf_file.filename == '':
        return jsonify({"error": "No se envió ningún archivo PDF válido"}), 400
    
    try:
        pdf_text = extract_pdf_text(pdf_file.stream)
        
        # PROTECCIÓN DE TOKENS: Cortamos a los primeros 3000 caracteres (~700 tokens)
        texto_resumido = pdf_text[:3000]
        
        preguntas = generate_questions(texto_resumido, materia, tema)
        codigo = generate_room_code(5)
        
        # Guardar en Firestore si está disponible
        if db:
            sala_doc = {
                "codigo":     codigo,
                "materia":    materia,
                "tema":       tema,
                "preguntas":  preguntas,
                "creado_por": "api_externa",
                "activa":     True,
                "timestamp":  firestore.SERVER_TIMESTAMP
            }
            db.collection("salas_activas").document(codigo).set(sala_doc)

            # ── Guardar preguntas individuales en colección 'preguntas' ──────────
            q_batch = db.batch()

            for idx, q in enumerate(preguntas.get("cerradas", []), start=1):
                doc_ref = db.collection("preguntas").document(f"{codigo}_cerrada_{idx:02d}")
                q_batch.set(doc_ref, {
                    "codigo_sala": codigo,
                    "materia":     materia,
                    "tema":        tema,
                    "tipo":        "cerrada",
                    "numero":      idx,
                    "pregunta":    q.get("pregunta", ""),
                    "opciones":    q.get("opciones", {}),
                    "correcta":    q.get("correcta", ""),
                    "timestamp":   firestore.SERVER_TIMESTAMP,
                })

            for idx, q in enumerate(preguntas.get("abiertas", []), start=1):
                doc_ref = db.collection("preguntas").document(f"{codigo}_abierta_{idx:02d}")
                q_batch.set(doc_ref, {
                    "codigo_sala": codigo,
                    "materia":     materia,
                    "tema":        tema,
                    "tipo":        "abierta",
                    "numero":      idx,
                    "pregunta":    q.get("pregunta", ""),
                    "respuesta":   q.get("respuesta", ""),
                    "timestamp":   firestore.SERVER_TIMESTAMP,
                })

            q_batch.commit()
            print(f"[LORE API] Preguntas guardadas en colección 'preguntas' con codigo_sala='{codigo}'.")

            if "telemetria_simulada" in preguntas:
                batch = db.batch()
                for student in preguntas["telemetria_simulada"]:
                    doc_ref = db.collection("telemetria_resultados").document(student["alumno_id"])
                    s_data = dict(student)
                    s_data["timestamp"] = firestore.SERVER_TIMESTAMP
                    batch.set(doc_ref, s_data)
                batch.commit()
            print(f"[LORE API] Sala '{codigo}' y telemetría demostrativa guardadas en Firestore.")

            print(f"[LORE API] Sala '{codigo}' creada desde /upload-pdf y guardada en Firestore.")
        
        return jsonify({
            "status": "success",
            "message": "Niveles generados exitosamente",
            "codigo": codigo,
            "data": preguntas
        })
    except Exception as exc:
        print(f"[LORE API] Error en /upload-pdf: {exc}")
# ── /api/seed-telemetria (Insertar datos de telemetría simulados en Firestore) ──
@app.route('/api/seed-telemetria', methods=['POST', 'GET'])
def seed_telemetria():
    """
    Inserta o actualiza un bloque de datos simulados de telemetría académica
    (Probabilidad y Estadística) en la colección 'telemetria_resultados' de Firestore.
    """
    mock_students = [
        {
            "alumno_id": "ALUMNO_101",
            "estado_final": "victoria",
            "historial_aciertos": ["PROMEDIO", "MEDIANA", "MODA", "CUALITATIVO", "MUESTRA"],
            "historial_errores": ["RANGO"],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_102",
            "estado_final": "victoria",
            "historial_aciertos": ["PROMEDIO", "CUALITATIVO", "POBLACIÓN", "MUESTRA", "PROBABILIDAD"],
            "historial_errores": ["MEDIANA"],
            "total_disparos": 7
        },
        {
            "alumno_id": "ALUMNO_103",
            "estado_final": "derrota",
            "historial_aciertos": ["MUESTRA", "FRECUENCIA"],
            "historial_errores": ["PROMEDIO", "MEDIANA", "RANGO"],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_104",
            "estado_final": "victoria",
            "historial_aciertos": ["PROMEDIO", "MEDIANA", "MODA", "CUANTITATIVO", "FRECUENCIA"],
            "historial_errores": [],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_105",
            "estado_final": "derrota",
            "historial_aciertos": ["CUALITATIVO"],
            "historial_errores": ["PROMEDIO", "RANGO", "MEDIANA", "POBLACIÓN"],
            "total_disparos": 5
        },
        {
            "alumno_id": "ALUMNO_106",
            "estado_final": "victoria",
            "historial_aciertos": ["PROMEDIO", "MODA", "POBLACIÓN", "MUESTRA", "EVENTO"],
            "historial_errores": ["ESPACIO MUESTRAL"],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_107",
            "estado_final": "victoria",
            "historial_aciertos": ["MEDIA", "MEDIANA", "MODA", "PROBABILIDAD", "FRECUENCIA"],
            "historial_errores": ["RANGO"],
            "total_disparos": 6
        },
        {
            "alumno_id": "ALUMNO_108",
            "estado_final": "derrota",
            "historial_aciertos": ["EVENTO", "MUESTRA"],
            "historial_errores": ["RANGO", "PROMEDIO", "MEDIANA"],
            "total_disparos": 5
        }
    ]
    
    if db:
        try:
            batch = db.batch()
            for student in mock_students:
                doc_ref = db.collection("telemetria_resultados").document(student["alumno_id"])
                student_data = dict(student)
                student_data["timestamp"] = firestore.SERVER_TIMESTAMP
                batch.set(doc_ref, student_data)
            batch.commit()
            print("[LORE] 8 registros de telemetría simulada insertados en Firestore.")
            return jsonify({
                "status": "success",
                "message": "Datos de telemetría simulados guardados exitosamente en Firestore.",
                "registros": len(mock_students)
            })
        except Exception as exc:
            print(f"[LORE] Error al sembrar telemetría: {exc}")
            return jsonify({"error": str(exc)}), 500
    else:
        return jsonify({
            "status": "demo_local",
            "message": "Firestore no configurado. El dashboard usará la simulación local de fallback.",
            "registros": mock_students
        })


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app.run(debug=True, port=5000)


