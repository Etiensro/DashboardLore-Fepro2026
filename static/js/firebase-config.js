/**
 * LORE — Panel Docente · firebase-config.js
 *  RESTRICCION: Este archivo solo inicializa Firebase.
 *  No contiene logica de escritura, actualizacion ni borrado.
 */

// ── REEMPLAZA CON TUS CREDENCIALES ───────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDtWZ7tfeLbF_Q4ImO6PBiibxtF0t2PMN4",
  authDomain: "lore-fepro.firebaseapp.com",
  projectId: "lore-fepro",
  storageBucket: "lore-fepro.firebasestorage.app",
  messagingSenderId: "849003250108",
  appId: "1:849003250108:web:30e96478b0aa8430d5abb9"
};
// ─────────────────────────────────────────────────────────────────────────────

// ── Inicializar Firebase ──────────────────────────────────────────────────────
window.firebaseReady = false;
window.db = null;

try {
  const app = firebase.initializeApp(firebaseConfig);
  window.db = firebase.firestore();

  // Opcional: emulador local (descomenta si usas Firebase Emulator Suite)
  // window.db.useEmulator("localhost", 8080);

  window.firebaseReady = true;
  console.log("[LORE] Firebase inicializado correctamente.");

} catch (err) {
  console.error("[LORE] Error al inicializar Firebase:", err.message);
}
