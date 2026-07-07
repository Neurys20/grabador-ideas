/**
 * app.js — Controlador principal de la UI
 *
 * Responsabilidades:
 * • Conecta la UI con recorder.js (grabación) y db.js (persistencia)
 * • Gestiona el estado de la aplicación (recording, processing, idle)
 * • Renderiza la lista de sesiones guardadas
 * • Controla el reproductor de audio
 * • Dibuja la forma de onda en tiempo real
 * • Gestiona la instalación PWA (beforeinstallprompt)
 */

// ── Estado global de la aplicación ───────────────────────────────────────

const AppState = {
  sessions:        [],       // Sesiones cargadas de IndexedDB
  activeSessionId: null,     // Sesión que se está grabando ahora
  currentSegIndex: 0,        // Segmento actual en grabación
  savedSegCount:   0,        // Cuántos segmentos se han guardado ya
  isProcessing:    false,    // Uniendo segmentos con FFmpeg/Blob concat
  timerInterval:   null,     // setInterval del contador de grabación
  waveformRaf:     null,     // requestAnimationFrame de la forma de onda
  sortOrder:       'desc',   // 'desc' = más reciente primero

  // Reproductor
  audioEl:         null,     // <audio> element actual
  playingId:       null,     // ID de la sesión reproduciéndose
  playbackUrl:     null,     // Object URL del audio en reproducción

  // Instalación PWA
  installPrompt:   null,
};

// ── Referencias DOM ───────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const DOM = {
  recordBtn:         $('recordBtn'),
  iconMic:           $('iconMic'),
  iconStop:          $('iconStop'),
  timerDisplay:      $('timerDisplay'),
  timerMeta:         $('timerMeta'),
  segmentIndicator:  $('segmentIndicator'),
  segmentLabel:      $('segmentLabel'),
  waveformCanvas:    $('waveformCanvas'),
  waveformIdle:      $('waveformIdle'),
  recordPanel:       $('recordPanel'),
  processingBanner:  $('processingBanner'),
  processingLabel:   $('processingLabel'),
  permError:         $('permError'),
  permErrorMsg:      $('permErrorMsg'),
  recordingsList:    $('recordingsList'),
  recordingsHeader:  $('recordingsHeader'),
  emptyState:        $('emptyState'),
  loadingState:      $('loadingState'),
  sessionCount:      $('sessionCount'),
  sortBtn:           $('sortBtn'),
  // Playback bar
  playbackBar:       $('playbackBar'),
  playbackToggle:    $('playbackToggle'),
  playbackTitle:     $('playbackTitle'),
  playbackClose:     $('playbackClose'),
  playbackSlider:    $('playbackSlider'),
  playbackPos:       $('playbackPos'),
  playbackDur:       $('playbackDur'),
  playIcon:          $('playIcon'),
  pauseIcon:         $('pauseIcon'),
  toastContainer:    $('toastContainer'),
};

// ── Inicialización ────────────────────────────────────────────────────────

async function init() {
  showLoading(true);

  // Cargar sesiones existentes
  try {
    await loadSessions();
  } catch (e) {
    console.error('[App] Error cargando sesiones:', e);
    showToast('No se pudieron cargar las grabaciones', 'error');
  }

  showLoading(false);
  renderSessionsList();
  attachEventListeners();
  setupPWAInstall();
  setupOfflineDetection();

  // Registrar Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('[SW] Registrado'))
      .catch(e => console.warn('[SW] No se pudo registrar:', e));
  }
}

// ── Carga de sesiones ─────────────────────────────────────────────────────

async function loadSessions() {
  AppState.sessions = await GrabadorDB.getAllSessions();
}

// ── Event listeners ───────────────────────────────────────────────────────

function attachEventListeners() {
  // Botón principal de grabación
  DOM.recordBtn.addEventListener('click', onRecordBtnClick);

  // Eventos del recorder
  recorder.addEventListener('start',          onRecorderStart);
  recorder.addEventListener('segmentSaved',   onSegmentSaved);
  recorder.addEventListener('segmentRotated', onSegmentRotated);
  recorder.addEventListener('stop',           onRecorderStop);
  recorder.addEventListener('error',          onRecorderError);

  // Reproductor
  DOM.playbackToggle.addEventListener('click', onPlaybackToggle);
  DOM.playbackClose.addEventListener('click', onPlaybackClose);
  DOM.playbackSlider.addEventListener('input', onSliderInput);

  // Ordenar lista
  DOM.sortBtn.addEventListener('click', () => {
    AppState.sortOrder = AppState.sortOrder === 'desc' ? 'asc' : 'desc';
    renderSessionsList();
  });
}

// ── Grabación: inicio / parada ─────────────────────────────────────────────

async function onRecordBtnClick() {
  if (AppState.isProcessing) return;

  if (recorder.isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  hidePermError();

  try {
    // 1. Crear sesión en IndexedDB
    const session = await GrabadorDB.createSession();
    AppState.activeSessionId = session.id;
    AppState.currentSegIndex = 0;
    AppState.savedSegCount   = 0;

    // 2. Iniciar grabación segmentada
    await recorder.start(session.id);

    // (El estado de UI se actualiza en onRecorderStart via evento)
  } catch (err) {
    AppState.activeSessionId = null;
    if (err.message === 'PERMISSION_DENIED') {
      showPermError('Permiso de micrófono denegado. Actívalo en los ajustes del navegador (🔒 en la barra de URL).');
    } else {
      showToast('No se pudo iniciar la grabación', 'error');
      console.error('[App] Error iniciando grabación:', err);
    }
  }
}

async function stopRecording() {
  try {
    // 1. Actualizar UI a estado "procesando"
    setProcessingState(true, 'Guardando grabación…');

    // 2. Detener recorder (guarda último segmento)
    const { sessionId, segmentCount, totalDurationMs } = await recorder.stop();

    // 3. Unir todos los segmentos en un único Blob
    setProcessingState(true, 'Uniendo segmentos…');

    let finalBlob = null;
    let totalMs   = totalDurationMs;

    try {
      const merged = await GrabadorDB.mergeSessionSegments(sessionId);
      finalBlob = merged.blob;
      totalMs   = merged.totalDurationMs || totalDurationMs;

      // 4. Guardar Blob final
      await GrabadorDB.saveFinalBlob(sessionId, finalBlob, totalMs);

      // 5. Eliminar segmentos temporales (libera espacio)
      await GrabadorDB.deleteSegments(sessionId);

      // 6. Marcar sesión como completada
      await GrabadorDB.updateSession(sessionId, {
        status:          'completed',
        totalDurationMs: totalMs,
        segmentCount,
        finalBlobKey:    `${sessionId}_-001`,
      });

    } catch (mergeErr) {
      // Si falla la unión, guardar como 'partial' (los segmentos siguen ahí)
      console.error('[App] Error uniendo segmentos:', mergeErr);
      await GrabadorDB.updateSession(sessionId, {
        status:          'partial',
        totalDurationMs: totalMs,
        segmentCount,
      });
      showToast('Grabación guardada parcialmente', 'error');
    }

    // 7. Recargar y renderizar
    await loadSessions();
    renderSessionsList();

    setProcessingState(false);
    showToast('Grabación guardada ✓', 'success');
    AppState.activeSessionId = null;

  } catch (err) {
    console.error('[App] Error deteniendo grabación:', err);
    setProcessingState(false);
    showToast('Error al guardar la grabación', 'error');
    AppState.activeSessionId = null;
  }
}

// ── Eventos del Recorder ──────────────────────────────────────────────────

function onRecorderStart(event) {
  const { sessionId } = event.detail;

  // UI: estado de grabación activo
  DOM.recordBtn.classList.add('is-recording');
  DOM.recordPanel.classList.add('is-recording');
  DOM.timerDisplay.classList.add('is-recording');
  DOM.iconMic.style.display  = 'none';
  DOM.iconStop.style.display = 'block';
  DOM.segmentIndicator.style.display = 'flex';
  DOM.timerMeta.textContent = 'Grabando · toca para detener';
  updateSegmentLabel();

  // Iniciar timer visual
  startTimerDisplay();

  // Iniciar visualizador de forma de onda
  startWaveform();
}

function onSegmentSaved(event) {
  AppState.savedSegCount++;
  updateSegmentLabel();
}

function onSegmentRotated(event) {
  AppState.currentSegIndex = event.detail.newIndex;
  updateSegmentLabel();
}

function onRecorderStop(event) {
  stopTimerDisplay();
  stopWaveform();

  DOM.recordBtn.classList.remove('is-recording');
  DOM.recordPanel.classList.remove('is-recording');
  DOM.timerDisplay.classList.remove('is-recording');
  DOM.timerDisplay.textContent = '00:00:00';
  DOM.iconMic.style.display  = 'block';
  DOM.iconStop.style.display = 'none';
  DOM.segmentIndicator.style.display = 'none';
  DOM.timerMeta.textContent = 'Pulsa para grabar';
}

function onRecorderError(event) {
  console.error('[App] Recorder error:', event.detail);
  stopTimerDisplay();
  stopWaveform();
  setProcessingState(false);
  showToast('Error en la grabación', 'error');
}

function updateSegmentLabel() {
  const seg  = AppState.currentSegIndex + 1;
  const saved = AppState.savedSegCount;
  DOM.segmentLabel.textContent = `Segmento ${seg}  ·  ${saved} guardado${saved !== 1 ? 's' : ''}`;
}

// ── Timer visual ──────────────────────────────────────────────────────────

function startTimerDisplay() {
  AppState.timerInterval = setInterval(() => {
    DOM.timerDisplay.textContent = RecorderUtils.formatTimer(recorder.elapsedMs);
  }, 500);
}

function stopTimerDisplay() {
  clearInterval(AppState.timerInterval);
  AppState.timerInterval = null;
}

// ── Visualizador de forma de onda ─────────────────────────────────────────

function startWaveform() {
  const canvas  = DOM.waveformCanvas;
  const ctx     = canvas.getContext('2d');
  const analyser = recorder.analyser;
  if (!analyser) return;

  const bufferLen = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLen);

  function resize() {
    canvas.width  = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    if (!recorder.isRecording) return;
    AppState.waveformRaf = requestAnimationFrame(draw);

    analyser.getByteTimeDomainData(dataArray);

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;

    ctx.clearRect(0, 0, W, H);

    // Fondo transparente
    ctx.fillStyle = 'transparent';

    // Dibujar forma de onda
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(232, 57, 43, 0.7)';
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    const sliceWidth = W / bufferLen;
    let x = 0;

    for (let i = 0; i < bufferLen; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Línea central sutil
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(232, 57, 43, 0.15)';
    ctx.lineWidth   = 0.5;
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }

  draw();
}

function stopWaveform() {
  cancelAnimationFrame(AppState.waveformRaf);
  AppState.waveformRaf = null;
  const canvas = DOM.waveformCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Estado de procesamiento ───────────────────────────────────────────────

function setProcessingState(active, label = 'Procesando…') {
  AppState.isProcessing = active;

  if (active) {
    DOM.processingBanner.style.display = 'flex';
    DOM.processingLabel.textContent    = label;
    DOM.timerDisplay.classList.remove('is-recording');
    DOM.timerDisplay.classList.add('is-processing');
  } else {
    DOM.processingBanner.style.display = 'none';
    DOM.timerDisplay.classList.remove('is-processing');
    DOM.timerDisplay.textContent = '00:00:00';
  }
}

// ── Renderizado de la lista ───────────────────────────────────────────────

function renderSessionsList() {
  const sessions = [...AppState.sessions];

  // Aplicar ordenación
  if (AppState.sortOrder === 'asc') sessions.reverse();

  // Header
  DOM.recordingsHeader.style.display = sessions.length > 0 ? 'flex' : 'none';
  DOM.emptyState.style.display       = sessions.length === 0 ? 'flex' : 'none';

  // Session count en header de app
  DOM.sessionCount.textContent = sessions.length > 0
    ? `${sessions.length} idea${sessions.length !== 1 ? 's' : ''}`
    : '';

  // Limpiar lista
  DOM.recordingsList.innerHTML = '';

  for (const session of sessions) {
    DOM.recordingsList.appendChild(createSessionItem(session));
  }
}

function createSessionItem(session) {
  const li  = document.createElement('li');
  li.className  = 'recording-item';
  li.dataset.id = session.id;

  const isPlaying    = AppState.playingId === session.id;
  const isProcessing = session.status === 'processing';
  const isError      = session.status === 'error';
  const isPartial    = session.status === 'partial';
  const isReady      = session.status === 'completed';

  if (isPlaying) li.classList.add('is-playing');
  if (isError)   li.classList.add('is-error');

  const date = RecorderUtils.formatRelativeDate(session.createdAt);
  const dur  = session.totalDurationMs
    ? RecorderUtils.formatDuration(session.totalDurationMs)
    : null;
  const segs = session.segmentCount
    ? `${session.segmentCount} seg.`
    : null;

  // Nombre de la grabación (por fecha/hora)
  const d = new Date(session.createdAt);
  const name = `Idea · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;

  // Badge de estado
  let badgeHTML = '';
  if (isProcessing) badgeHTML = `<span class="item-badge badge-processing">Procesando</span>`;
  if (isError)      badgeHTML = `<span class="item-badge badge-error">Error</span>`;
  if (isPartial)    badgeHTML = `<span class="item-badge badge-partial">Parcial</span>`;

  // Icono del botón play/estado
  let playIconHTML = '';
  if (isPlaying) {
    playIconHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
      <rect x="11" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
    </svg>`;
  } else if (isProcessing) {
    playIconHTML = `<div style="width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></div>`;
  } else if (isError || isPartial) {
    playIconHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="7.5" stroke="currentColor" stroke-width="1.4"/>
      <line x1="9" y1="5" x2="9" y2="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="9" cy="13" r="1" fill="currentColor"/>
    </svg>`;
  } else {
    playIconHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <polygon points="4,2 15,9 4,16" fill="currentColor"/>
    </svg>`;
  }

  // Minibarra de progreso (solo si está reproduciéndose)
  const progressHTML = isPlaying
    ? `<div class="item-progress"><div class="item-progress-fill" id="progress-${session.id}"></div></div>`
    : '';

  li.innerHTML = `
    <div class="item-main">
      <button class="item-play-btn" data-action="play" aria-label="${isPlaying ? 'Detener' : 'Reproducir'}">
        ${playIconHTML}
      </button>
      <div class="item-info">
        <div class="item-name">${escapeHtml(name)}</div>
        <div class="item-meta">
          <span class="item-date">${date}</span>
          ${dur ? `<span class="meta-sep">·</span><span class="item-dur">${dur}</span>` : ''}
          ${segs ? `<span class="meta-sep">·</span><span class="item-segs">${segs}</span>` : ''}
          ${badgeHTML}
        </div>
      </div>
      <button class="item-delete-btn" data-action="delete" aria-label="Eliminar grabación">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 4h10M6 4V2h4v2M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    ${progressHTML}
  `;

  // Eventos del item
  li.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'play')   onItemPlayClick(session);
    if (action === 'delete') onItemDeleteClick(session, li);
  });

  return li;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Reproducción ──────────────────────────────────────────────────────────

async function onItemPlayClick(session) {
  // Si ya está reproduciéndose este → pausar/reanudar
  if (AppState.playingId === session.id) {
    if (AppState.audioEl?.paused) {
      AppState.audioEl.play();
    } else {
      AppState.audioEl?.pause();
    }
    return;
  }

  // Detener reproducción anterior
  closePlayback();

  // Solo reproducir si hay archivo final
  if (session.status !== 'completed' && session.status !== 'partial') {
    if (session.status === 'partial') {
      showToast('La grabación se guardó parcialmente', 'error');
    }
    return;
  }

  try {
    // Obtener Blob final desde IndexedDB
    const seg = await GrabadorDB.getFinalBlob(session.id);
    let blob  = seg?.blob;

    // Fallback: si no hay blob final, intentar unir los segmentos
    if (!blob) {
      if (session.status === 'partial') {
        const merged = await GrabadorDB.mergeSessionSegments(session.id);
        blob = merged.blob;
      } else {
        showToast('Archivo de audio no encontrado', 'error');
        return;
      }
    }

    // Crear Object URL temporal
    AppState.playbackUrl = URL.createObjectURL(blob);
    const audio = new Audio(AppState.playbackUrl);
    AppState.audioEl  = audio;
    AppState.playingId = session.id;

    // Eventos del audio
    audio.addEventListener('loadedmetadata', () => {
      DOM.playbackDur.textContent = RecorderUtils.formatDuration(audio.duration * 1000);
    });

    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      DOM.playbackSlider.value = pct;
      DOM.playbackSlider.style.setProperty('--pct', `${pct}%`);
      DOM.playbackPos.textContent = RecorderUtils.formatDuration(audio.currentTime * 1000);

      // Actualizar minibarra del item
      const fill = document.getElementById(`progress-${session.id}`);
      if (fill) fill.style.width = `${pct}%`;
    });

    audio.addEventListener('ended', () => {
      closePlayback();
    });

    audio.addEventListener('pause', () => {
      DOM.playIcon.style.display  = 'block';
      DOM.pauseIcon.style.display = 'none';
    });

    audio.addEventListener('play', () => {
      DOM.playIcon.style.display  = 'none';
      DOM.pauseIcon.style.display = 'block';
    });

    // Mostrar barra de reproducción
    const d = new Date(session.createdAt);
    DOM.playbackTitle.textContent = `Idea · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
    DOM.playbackBar.style.display = 'block';
    DOM.playIcon.style.display    = 'none';
    DOM.pauseIcon.style.display   = 'block';

    await audio.play();
    renderSessionsList(); // Actualiza el item a estado "playing"

  } catch (err) {
    console.error('[App] Error reproduciendo:', err);
    showToast('No se pudo reproducir el audio', 'error');
    closePlayback();
  }
}

function onPlaybackToggle() {
  if (!AppState.audioEl) return;
  if (AppState.audioEl.paused) {
    AppState.audioEl.play();
  } else {
    AppState.audioEl.pause();
  }
}

function onSliderInput(e) {
  if (!AppState.audioEl?.duration) return;
  const pct = e.target.value / 100;
  AppState.audioEl.currentTime = pct * AppState.audioEl.duration;
}

function onPlaybackClose() {
  closePlayback();
  renderSessionsList();
}

function closePlayback() {
  if (AppState.audioEl) {
    AppState.audioEl.pause();
    AppState.audioEl = null;
  }
  if (AppState.playbackUrl) {
    URL.revokeObjectURL(AppState.playbackUrl);
    AppState.playbackUrl = null;
  }
  AppState.playingId = null;
  DOM.playbackBar.style.display = 'none';
  DOM.playbackSlider.value = 0;
  DOM.playbackPos.textContent = '0:00';
  DOM.playbackDur.textContent = '0:00';
}

// ── Eliminar sesión ───────────────────────────────────────────────────────

async function onItemDeleteClick(session, li) {
  // Si está reproduciéndose, detener primero
  if (AppState.playingId === session.id) closePlayback();

  // Confirmar
  const ok = confirm(`¿Eliminar esta grabación?\n\nNo se puede deshacer.`);
  if (!ok) return;

  // Animación de salida
  li.style.opacity    = '0';
  li.style.transform  = 'translateX(-10px)';
  li.style.transition = 'opacity 0.2s, transform 0.2s';

  setTimeout(async () => {
    try {
      await GrabadorDB.deleteSession(session.id);
      AppState.sessions = AppState.sessions.filter(s => s.id !== session.id);
      renderSessionsList();
      showToast('Grabación eliminada', 'success');
    } catch (err) {
      console.error('[App] Error eliminando:', err);
      li.style.opacity   = '1';
      li.style.transform = '';
      showToast('No se pudo eliminar', 'error');
    }
  }, 200);
}

// ── Helpers de UI ─────────────────────────────────────────────────────────

function showLoading(visible) {
  DOM.loadingState.style.display = visible ? 'flex' : 'none';
  if (visible) DOM.emptyState.style.display = 'none';
}

function showPermError(msg) {
  DOM.permErrorMsg.textContent = msg || 'Permiso de micrófono denegado.';
  DOM.permError.style.display = 'flex';
}

function hidePermError() {
  DOM.permError.style.display = 'none';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = type === 'success'
    ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polyline points="2,7 5.5,10.5 12,4" stroke="#00d4a0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : type === 'error'
    ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#ff6b6b" stroke-width="1.4"/><line x1="7" y1="4" x2="7" y2="8" stroke="#ff6b6b" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10.5" r="0.8" fill="#ff6b6b"/></svg>`
    : '';

  toast.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  DOM.toastContainer.prepend(toast);

  setTimeout(() => toast.remove(), 3000);
}

// ── Instalación PWA ───────────────────────────────────────────────────────

function setupPWAInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    AppState.installPrompt = e;

    // Mostrar banner de instalación
    const banner = document.createElement('div');
    banner.className = 'install-banner visible';
    banner.innerHTML = `
      <div class="install-text">
        <strong>Instalar app</strong>
        Accede sin navegador, funciona sin conexión
      </div>
      <button class="install-btn" id="installBtn">Instalar</button>
      <button class="install-dismiss" id="installDismiss" aria-label="Cerrar">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    document.querySelector('.recordings-section').prepend(banner);

    document.getElementById('installBtn').addEventListener('click', async () => {
      AppState.installPrompt.prompt();
      const { outcome } = await AppState.installPrompt.userChoice;
      banner.remove();
      AppState.installPrompt = null;
      if (outcome === 'accepted') showToast('App instalada ✓', 'success');
    });

    document.getElementById('installDismiss').addEventListener('click', () => banner.remove());
  });
}

// ── Detección de red ──────────────────────────────────────────────────────

function setupOfflineDetection() {
  const banner = document.createElement('div');
  banner.className = 'offline-banner';
  banner.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 2l10 10M7 5a5 5 0 015 5M2 7a7 7 0 017-7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
    <span>Sin conexión · La grabación sigue funcionando</span>
  `;
  document.body.prepend(banner);

  const update = () => {
    banner.classList.toggle('visible', !navigator.onLine);
  };

  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ── Arranque ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
