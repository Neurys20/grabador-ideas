/**
 * recorder.js — Motor de grabación segmentada
 *
 * Arquitectura de bajo consumo de RAM:
 * ─────────────────────────────────────
 * • Usa MediaRecorder con timeslice para recibir chunks pequeños
 * • Cada SEGMENT_DURATION_MS acumula los chunks en un array local
 * • Al completar un segmento → crea un Blob → guarda en IndexedDB → vacía el array
 * • En ningún momento hay más de ~30s de audio en memoria RAM
 *
 * Tolerancia a fallos:
 * • Si la app se cierra, los segmentos ya guardados en IndexedDB persisten
 * • Al reabrir, se pueden recuperar y unir manualmente desde la UI
 *
 * Optimización de batería:
 * • sampleRate: 16000 Hz (suficiente para voz)
 * • channelCount: 1 (mono)
 * • Bitrate: 32kbps AAC/opus
 */

const SEGMENT_DURATION_MS = 30 * 1000;   // 30 segundos por segmento
const CHUNK_INTERVAL_MS   = 1000;         // MediaRecorder emite cada 1s

// Formatos soportados, en orden de preferencia
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

class SegmentedRecorder extends EventTarget {
  constructor() {
    super();

    this._mediaRecorder  = null;
    this._stream         = null;
    this._sessionId      = null;
    this._segmentIndex   = 0;
    this._segmentChunks  = [];     // Chunks del segmento actual (en RAM)
    this._segmentStart   = 0;      // Timestamp de inicio del segmento actual
    this._rotateTimer    = null;   // Timer de rotación de segmento
    this._totalStartTime = 0;      // Para calcular duración total
    this._mimeType       = null;
    this._isRecording    = false;
    this._isPaused       = false;
    this._analyser       = null;   // Para visualización de forma de onda
    this._audioCtx       = null;
  }

  // ── Estado ──────────────────────────────────────────────────────────────

  get isRecording()  { return this._isRecording; }
  get isPaused()     { return this._isPaused; }
  get sessionId()    { return this._sessionId; }
  get segmentIndex() { return this._segmentIndex; }
  get mimeType()     { return this._mimeType; }
  get analyser()     { return this._analyser; }

  get elapsedMs() {
    if (!this._isRecording) return 0;
    if (this._isPaused) return this._pausedAt - this._totalStartTime;
    return Date.now() - this._totalStartTime;
  }

  // ── Selección de formato ─────────────────────────────────────────────────

  static getSupportedMimeType() {
    for (const type of PREFERRED_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return ''; // El navegador usa su default
  }

  // ── Inicio de grabación ──────────────────────────────────────────────────

  /**
   * Solicita permiso de micrófono e inicia la grabación segmentada.
   * @param {string} sessionId — ID de la sesión ya creada en IndexedDB
   * @returns {Promise<void>}
   */
  async start(sessionId) {
    if (this._isRecording) throw new Error('Ya hay una grabación en curso');

    // 1. Solicitar acceso al micrófono (optimizado para voz / bajo consumo)
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate:   { ideal: 16000 },
          channelCount: { ideal: 1 },
          echoCancellation:    true,
          noiseSuppression:    true,
          autoGainControl:     true,
        },
        video: false,
      });
    } catch (err) {
      const isPerm = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      throw Object.assign(new Error(isPerm
        ? 'PERMISSION_DENIED'
        : `MIC_ERROR: ${err.message}`
      ), { cause: err });
    }

    // 2. Configurar el analizador de forma de onda
    this._setupAnalyser();

    // 3. Seleccionar formato de audio
    this._mimeType = SegmentedRecorder.getSupportedMimeType();

    // 4. Configurar estado
    this._sessionId      = sessionId;
    this._segmentIndex   = 0;
    this._segmentChunks  = [];
    this._segmentStart   = Date.now();
    this._totalStartTime = Date.now();
    this._isRecording    = true;
    this._isPaused       = false;

    // 5. Iniciar MediaRecorder
    this._startMediaRecorder();

    // 6. Programar rotación de segmento cada 30s
    this._scheduleRotation();

    this._emit('start', { sessionId });
  }

  // ── MediaRecorder interno ────────────────────────────────────────────────

  _startMediaRecorder() {
    const options = {};
    if (this._mimeType) options.mimeType = this._mimeType;

    // audioBitsPerSecond: 32kbps es suficiente para voz, reduce tamaño ~4x
    options.audioBitsPerSecond = 32000;

    this._mediaRecorder = new MediaRecorder(this._stream, options);

    // `ondataavailable` se llama cada CHUNK_INTERVAL_MS
    // Los chunks llegan pequeños y se acumulan en _segmentChunks (en RAM)
    this._mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._segmentChunks.push(event.data);
      }
    };

    this._mediaRecorder.onerror = (err) => {
      console.error('[Recorder] MediaRecorder error:', err);
      this._emit('error', { error: err });
    };

    // timeslice: emite datos cada 1 segundo (no acumula en RAM)
    this._mediaRecorder.start(CHUNK_INTERVAL_MS);
  }

  // ── Rotación de segmento ─────────────────────────────────────────────────

  _scheduleRotation() {
    this._rotateTimer = setTimeout(() => {
      if (this._isRecording && !this._isPaused) {
        this._rotateSegment();
      }
    }, SEGMENT_DURATION_MS);
  }

  /**
   * Cierra el segmento actual, lo guarda en IndexedDB e inicia el siguiente.
   * Este es el corazón del sistema de bajo consumo de RAM.
   */
  async _rotateSegment() {
    const index     = this._segmentIndex;
    const startedAt = this._segmentStart;
    const durationMs = Date.now() - startedAt;

    // 1. Detener MediaRecorder (dispara último ondataavailable)
    await this._stopMediaRecorderAndWait();

    // 2. Crear Blob del segmento desde los chunks acumulados
    const segmentBlob = new Blob(this._segmentChunks, {
      type: this._mimeType || 'audio/webm',
    });

    // 3. GUARDAR EN INDEXEDDB INMEDIATAMENTE (persistencia garantizada)
    try {
      await GrabadorDB.saveSegment(this._sessionId, index, segmentBlob, durationMs);
      this._emit('segmentSaved', { index, durationMs, size: segmentBlob.size });
    } catch (err) {
      console.error('[Recorder] Error guardando segmento:', err);
      this._emit('error', { error: err });
      // No lanzar — intentar continuar con el siguiente segmento
    }

    // 4. Vaciar chunks de RAM (el segmento ya está en disco)
    this._segmentChunks = [];
    this._segmentIndex  = index + 1;
    this._segmentStart  = Date.now();

    // 5. Iniciar MediaRecorder nuevo para el siguiente segmento
    this._startMediaRecorder();

    // 6. Programar la próxima rotación
    this._scheduleRotation();

    this._emit('segmentRotated', { newIndex: this._segmentIndex });
  }

  _stopMediaRecorderAndWait() {
    return new Promise((resolve) => {
      if (!this._mediaRecorder || this._mediaRecorder.state === 'inactive') {
        resolve();
        return;
      }
      // Al llamar stop(), se dispara ondataavailable con el último chunk
      // y luego onstop
      this._mediaRecorder.onstop = () => resolve();
      this._mediaRecorder.stop();
    });
  }

  // ── Detener grabación ────────────────────────────────────────────────────

  /**
   * Detiene la grabación, guarda el último segmento y retorna la sesión.
   * @returns {Promise<{sessionId, segmentCount, totalDurationMs}>}
   */
  async stop() {
    if (!this._isRecording) throw new Error('No hay grabación activa');

    // 1. Cancelar timer de rotación
    clearTimeout(this._rotateTimer);
    this._rotateTimer = null;

    const lastIndex   = this._segmentIndex;
    const durationMs  = Date.now() - this._segmentStart;
    const totalMs     = Date.now() - this._totalStartTime;

    // 2. Detener MediaRecorder y esperar el último chunk
    await this._stopMediaRecorderAndWait();

    // 3. Guardar último segmento (si tiene datos)
    if (this._segmentChunks.length > 0) {
      const lastBlob = new Blob(this._segmentChunks, {
        type: this._mimeType || 'audio/webm',
      });
      if (lastBlob.size > 100) { // Ignorar blobs casi vacíos
        await GrabadorDB.saveSegment(this._sessionId, lastIndex, lastBlob, durationMs);
      }
    }

    // 4. Limpiar stream
    this._stream.getTracks().forEach(t => t.stop());
    this._stream = null;
    this._segmentChunks = [];

    // 5. Limpiar audio context
    if (this._audioCtx) {
      this._audioCtx.close();
      this._audioCtx = null;
      this._analyser = null;
    }

    const segmentCount = lastIndex + 1;
    const result = { sessionId: this._sessionId, segmentCount, totalDurationMs: totalMs };

    // 6. Reset estado
    this._isRecording = false;
    this._isPaused    = false;

    this._emit('stop', result);
    return result;
  }

  // ── Analizador de forma de onda ──────────────────────────────────────────

  _setupAnalyser() {
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source   = this._audioCtx.createMediaStreamSource(this._stream);
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyser.smoothingTimeConstant = 0.8;
      source.connect(this._analyser);
      // No conectar al destino (evita escucharse a uno mismo)
    } catch (e) {
      console.warn('[Recorder] Analizador no disponible:', e);
    }
  }

  // ── Helpers de eventos ───────────────────────────────────────────────────

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ── Instancia global ──────────────────────────────────────────────────────

window.recorder = new SegmentedRecorder();

// ── Helpers de formato ────────────────────────────────────────────────────

/**
 * Formatea milisegundos a HH:MM:SS
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padLeft(2, '0')}:${String(sec).padLeft(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Formatea milisegundos a HH:MM:SS para el display del timer (siempre HH:MM:SS)
 */
function formatTimer(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h   = Math.floor(totalSec / 3600);
  const m   = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Formatea una fecha relativa (Hoy, Ayer, dd/mm)
 */
function formatRelativeDate(timestamp) {
  const date = new Date(timestamp);
  const now  = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d     = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffDays = Math.round((today - d) / 86400000);
  const hm = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `Hoy · ${hm}`;
  if (diffDays === 1) return `Ayer · ${hm}`;
  return date.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ` · ${hm}`;
}

// Corregir el padLeft en String que usamos arriba
if (!String.prototype.padLeft) {
  String.prototype.padLeft = String.prototype.padStart;
}

window.RecorderUtils = { formatDuration, formatTimer, formatRelativeDate };
