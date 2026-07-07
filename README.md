# Grabador de Ideas — PWA

Aplicación web progresiva para grabar ideas de voz de forma continua y segura.
Funciona en cualquier navegador moderno, se instala en el móvil como app nativa
y funciona completamente sin conexión a internet.

## Características

- **Grabación continua** en segmentos de 30 segundos → cero pérdida de datos
- **Bajo consumo de RAM**: el audio nunca se acumula en memoria (se escribe a disco en cada segmento)
- **Persistencia total**: IndexedDB guarda cada segmento en el momento de grabarse
- **Recuperación de fallos**: si la app se cierra, los segmentos ya guardados persisten
- **Funciona offline**: Service Worker cachea todos los assets estáticos
- **Instalable**: manifest.json permite instalar en Android/iOS como app nativa
- **Visualizador de onda**: canvas en tiempo real durante la grabación
- **Reproducción integrada**: playback bar con slider de progreso

## Estructura de archivos

```
grabador-ideas-pwa/
├── index.html          # Shell HTML de la app
├── styles.css          # Diseño oscuro minimalista (tokens CSS)
├── db.js               # Capa de datos: IndexedDB (sesiones + segmentos)
├── recorder.js         # Motor de grabación segmentada (MediaRecorder API)
├── app.js              # Controlador UI: estado, render, eventos
├── sw.js               # Service Worker: cache-first + offline fallback
├── manifest.json       # Manifest PWA: iconos, nombre, colores, atajos
├── icons/              # Iconos en múltiples resoluciones
│   ├── icon-32.png
│   ├── icon-96.png
│   ├── icon-180.png    # Apple Touch Icon
│   ├── icon-192.png    # Android
│   └── icon-512.png    # Splash screen
└── README.md
```

## Cómo usar

### Opción 1: Servidor local (desarrollo)

```bash
# Python (cualquier máquina con Python 3)
cd grabador-ideas-pwa
python3 -m http.server 8080

# Abrir en el navegador:
# http://localhost:8080

# Para probar en móvil (misma red WiFi):
# http://TU_IP_LOCAL:8080
```

```bash
# Node.js con npx
npx serve grabador-ideas-pwa
# o
npx http-server grabador-ideas-pwa -p 8080
```

```bash
# Con Live Server de VS Code:
# Clic derecho en index.html → "Open with Live Server"
```

> ⚠️ **IMPORTANTE**: Los permisos de micrófono y el Service Worker
> requieren HTTPS en producción. En localhost funcionan sin HTTPS.

### Opción 2: Despliegue en producción (HTTPS requerido para PWA completa)

#### Netlify (gratis, el más sencillo)
```bash
# 1. Crear cuenta en netlify.com
# 2. Arrastrar la carpeta grabador-ideas-pwa al panel de Netlify
# 3. ¡Listo! Obtienes una URL HTTPS automáticamente
```

#### GitHub Pages
```bash
# 1. Crear repositorio en GitHub
git init
git add .
git commit -m "Grabador de Ideas PWA"
git remote add origin https://github.com/TU_USUARIO/grabador-ideas.git
git push -u origin main

# 2. En el repo: Settings → Pages → Source: main branch
# URL: https://TU_USUARIO.github.io/grabador-ideas/
```

#### Vercel
```bash
npm install -g vercel
cd grabador-ideas-pwa
vercel
# Sigue las instrucciones. Obtienes HTTPS automático.
```

#### Servidor propio (Apache/Nginx)
```bash
# Copiar archivos a /var/www/html/grabador-ideas/
# Asegurarse de tener SSL (Let's Encrypt / Certbot)
# Configurar headers de seguridad:
```

**nginx.conf snippet:**
```nginx
location /grabador-ideas/ {
    root /var/www/html;
    try_files $uri $uri/ /grabador-ideas/index.html;
    
    # Cache de assets
    location ~* \.(css|js|png|json)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## Instalar como app nativa

### Android (Chrome/Edge)
1. Abrir la URL en Chrome
2. Menú ⋮ → "Añadir a pantalla de inicio" o "Instalar app"
3. Confirmar instalación
4. La app aparece en el launcher como una app normal

### iOS (Safari)
1. Abrir la URL en Safari (Safari únicamente, no Chrome en iOS)
2. Botón de compartir (□↑) → "Añadir a pantalla de inicio"
3. Confirmar nombre → "Añadir"

> En iOS, el audio en segundo plano tiene limitaciones del sistema.
> La grabación funciona correctamente mientras la pantalla está activa.

## Arquitectura técnica

```
UI Events (app.js)
      │
      ├─→ SegmentedRecorder (recorder.js)
      │         │
      │         ├─→ MediaRecorder API (nativa del navegador)
      │         │         └─→ ondataavailable (cada 1s)
      │         │                   └─→ acumula chunks en RAM
      │         │
      │         └─→ cada 30s: _rotateSegment()
      │                   ├─→ Blob(chunks) → IndexedDB.saveSegment()
      │                   └─→ vacía RAM → inicia nuevo segmento
      │
      └─→ GrabadorDB (db.js)
                ├─→ createSession / updateSession
                ├─→ saveSegment (Blob → IndexedDB)
                ├─→ mergeSessionSegments (concat Blobs)
                └─→ getFinalBlob / deleteSegments
```

### Consumo de memoria (grabación de 1 hora)
| Qué | Tamaño |
|-----|--------|
| Segmento de 30s en RAM | ~120 KB |
| Archivo final 1h en disco | ~14 MB |
| Segmentos temporales en disco | ~14 MB (se eliminan al terminar) |

### Compatibilidad de navegadores
| Navegador | Grabación | Service Worker | IndexedDB |
|-----------|-----------|----------------|-----------|
| Chrome 80+ | ✅ | ✅ | ✅ |
| Firefox 75+ | ✅ | ✅ | ✅ |
| Safari 14.1+ | ✅ | ✅ | ✅ |
| Edge 80+ | ✅ | ✅ | ✅ |
| Chrome Android | ✅ | ✅ | ✅ |
| Safari iOS 14.4+ | ✅ | ✅ | ✅ |

## Roadmap (arquitectura preparada)

El código ya tiene los campos de datos preparados:
- `transcript`: para transcripción automática con Whisper API
- `tags[]`: para etiquetas y categorías
- `summary`: para resúmenes con IA
- `isSynced`: para sincronización con Google Drive / S3

```js
// Ejemplo de integración futura con Whisper:
async function transcribeSession(sessionId) {
  const seg = await GrabadorDB.getFinalBlob(sessionId);
  const formData = new FormData();
  formData.append('file', seg.blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('language', 'es');
  
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: formData,
  });
  const { text } = await res.json();
  await GrabadorDB.updateSession(sessionId, { transcript: text });
}
```

## Troubleshooting

**"No se pudo iniciar la grabación"**
→ Verificar que el navegador tiene permiso de micrófono:
   Chrome: 🔒 en la barra → Micrófono → Permitir
   Firefox: 🔒 → Permisos de conexión → Micrófono
   Safari: Preferencias → Sitios web → Micrófono

**El Service Worker no se registra**
→ Verificar que el sitio está en HTTPS (en localhost funciona sin HTTPS)

**El audio no suena al reproducir**
→ Verificar que el dispositivo no está en modo silencio
→ En iOS: asegurarse de que la grabación se completó correctamente

**Las grabaciones no persisten entre reinicios**
→ El navegador no debe estar en modo incógnito (IndexedDB se borra al cerrar)
→ Verificar que el navegador no tiene configuración de "borrar datos al salir"
