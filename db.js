/**
 * db.js — Capa de persistencia con IndexedDB
 *
 * Estructura de la base de datos:
 *   ├── sessions        — Metadatos de cada sesión de grabación
 *   └── segments        — Blobs de audio de cada segmento de 30s
 *
 * Sin pérdida de datos: cada segmento se escribe a IndexedDB
 * en cuanto el MediaRecorder lo cierra, ANTES de continuar con el siguiente.
 * Si la app se cierra entre segmentos, los que ya se guardaron persisten.
 */

const DB_NAME    = 'grabador-ideas-db';
const DB_VERSION = 1;

const STORE_SESSIONS  = 'sessions';
const STORE_SEGMENTS  = 'segments';

// ── Apertura de la base de datos ──────────────────────────────────────────

/** Abre (o crea) la base de datos. Retorna una Promise<IDBDatabase>. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Tabla de sesiones
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessionsStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
        sessionsStore.createIndex('status', 'status', { unique: false });
      }

      // Tabla de segmentos
      // Cada segmento tiene: id, sessionId, index, blob, duration, savedAt
      if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
        const segsStore = db.createObjectStore(STORE_SEGMENTS, { keyPath: 'id' });
        segsStore.createIndex('sessionId', 'sessionId', { unique: false });
        segsStore.createIndex('sessionId_index', ['sessionId', 'index'], { unique: true });
      }
    };

    req.onsuccess  = () => resolve(req.result);
    req.onerror    = () => reject(req.error);
  });
}

// Instancia singleton de la DB (se abre una vez al inicio)
let _db = null;

async function getDB() {
  if (!_db) _db = await openDB();
  return _db;
}

// ── Helper genérico de transacciones ─────────────────────────────────────

function txPromise(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.onerror = () => reject(tx.error);
    resolve(fn(tx));
  });
}

// ── SESSIONS CRUD ─────────────────────────────────────────────────────────

/**
 * Crea una nueva sesión y la guarda.
 * @returns {Promise<SessionRecord>}
 */
async function createSession() {
  const db = await getDB();
  const session = {
    id:           crypto.randomUUID(),
    createdAt:    Date.now(),
    status:       'recording',   // recording | processing | completed | error | partial
    totalDurationMs: 0,
    segmentCount:    0,
    finalBlobKey:    null,       // key en segments cuando se une todo
    transcript:      null,       // Para futura transcripción con IA
    tags:            [],         // Para futuras etiquetas
    summary:         null,       // Para futuro resumen con IA
    isSynced:        false,      // Para futura sincronización en nube
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const req = tx.objectStore(STORE_SESSIONS).add(session);
    req.onsuccess = () => resolve(session);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Actualiza una sesión existente (merge parcial).
 */
async function updateSession(id, changes) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const session = { ...getReq.result, ...changes };
      const putReq = store.put(session);
      putReq.onsuccess = () => resolve(session);
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Retorna todas las sesiones, ordenadas de más nueva a más antigua.
 * @returns {Promise<SessionRecord[]>}
 */
async function getAllSessions() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const req = tx.objectStore(STORE_SESSIONS).index('createdAt').getAll();
    req.onsuccess = () => resolve((req.result || []).reverse());
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Obtiene una sesión por ID.
 */
async function getSession(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const req = tx.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Elimina una sesión y todos sus segmentos asociados.
 */
async function deleteSession(sessionId) {
  const db = await getDB();
  // 1. Obtener todos los segmentos de la sesión
  const segments = await getSegmentsBySession(sessionId);

  return new Promise((resolve, reject) => {
    // Eliminar sesión + todos sus segmentos en una sola transacción
    const tx = db.transaction([STORE_SESSIONS, STORE_SEGMENTS], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);

    tx.objectStore(STORE_SESSIONS).delete(sessionId);
    const segStore = tx.objectStore(STORE_SEGMENTS);
    for (const seg of segments) {
      segStore.delete(seg.id);
    }
  });
}

// ── SEGMENTS CRUD ─────────────────────────────────────────────────────────

/**
 * Guarda un segmento de audio (Blob) en IndexedDB.
 * Se llama inmediatamente al cerrar cada segmento de 30s.
 *
 * @param {string} sessionId
 * @param {number} index — posición en la secuencia (0-based)
 * @param {Blob} blob — datos de audio AAC/WebM
 * @param {number} durationMs — duración en ms
 * @returns {Promise<SegmentRecord>}
 */
async function saveSegment(sessionId, index, blob, durationMs) {
  const db = await getDB();
  const segment = {
    id:         `${sessionId}_${String(index).padStart(4, '0')}`,
    sessionId,
    index,
    blob,          // El Blob audio se guarda directamente — no RAM, solo disco
    durationMs,
    savedAt:    Date.now(),
    mimeType:   blob.type,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
    const req = tx.objectStore(STORE_SEGMENTS).put(segment);
    req.onsuccess = () => resolve(segment);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Obtiene todos los segmentos de una sesión, ordenados por índice.
 * @returns {Promise<SegmentRecord[]>}
 */
async function getSegmentsBySession(sessionId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SEGMENTS, 'readonly');
    const req = tx.objectStore(STORE_SEGMENTS).index('sessionId').getAll(sessionId);
    req.onsuccess = () => {
      const sorted = (req.result || []).sort((a, b) => a.index - b.index);
      resolve(sorted);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Elimina todos los segmentos de audio temporales de una sesión.
 * Se llama después de unir los segmentos en un solo Blob final.
 * El segmento final (index -1) se guarda por separado.
 */
async function deleteSegments(sessionId) {
  const db = await getDB();
  const segments = await getSegmentsBySession(sessionId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    const store = tx.objectStore(STORE_SEGMENTS);
    for (const seg of segments) {
      // Solo borrar segmentos temporales (index >= 0), no el final (index === -1)
      if (seg.index >= 0) store.delete(seg.id);
    }
  });
}

/**
 * Guarda el Blob de audio final (unión de todos los segmentos).
 * Usa index = -1 como clave especial para el archivo final.
 */
async function saveFinalBlob(sessionId, blob, durationMs) {
  return saveSegment(sessionId, -1, blob, durationMs);
}

/**
 * Recupera el Blob final de una sesión completada.
 */
async function getFinalBlob(sessionId) {
  const db = await getDB();
  const key = `${sessionId}_-001`; // index -1 formateado
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SEGMENTS, 'readonly');
    const req = tx.objectStore(STORE_SEGMENTS).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

// ── AUDIO MERGE ───────────────────────────────────────────────────────────

/**
 * Une todos los segmentos de una sesión en un único Blob de audio.
 *
 * La Web Audio API / MediaRecorder no tiene una API oficial de concat,
 * así que simplemente concatenamos los Blobs en orden.
 * Para formatos con headers (webm/ogg), los navegadores son lo bastante
 * tolerantes para reproducir la concatenación. Para producción se podría
 * usar FFmpeg.wasm para un concat más limpio.
 *
 * @param {string} sessionId
 * @returns {Promise<{blob: Blob, totalDurationMs: number}>}
 */
async function mergeSessionSegments(sessionId) {
  const segments = await getSegmentsBySession(sessionId);

  if (segments.length === 0) {
    throw new Error('No hay segmentos para unir');
  }

  // Calcular duración total
  const totalDurationMs = segments.reduce((acc, s) => acc + (s.durationMs || 0), 0);

  // Concatenar blobs en orden
  const mimeType = segments[0].mimeType || 'audio/webm';
  const blobs = segments.map(s => s.blob);
  const finalBlob = new Blob(blobs, { type: mimeType });

  return { blob: finalBlob, totalDurationMs, mimeType };
}

// ── Exportación global ────────────────────────────────────────────────────

window.GrabadorDB = {
  // Sessions
  createSession,
  updateSession,
  getAllSessions,
  getSession,
  deleteSession,
  // Segments
  saveSegment,
  getSegmentsBySession,
  deleteSegments,
  saveFinalBlob,
  getFinalBlob,
  mergeSessionSegments,
};
