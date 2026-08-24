// ============================================================================
// SIRA BRIDGE — SiraBridge.mjs  (reconstruido post-desastre, v2)
// El puente entre mindcraft y el sistema nervioso de Sira.
//
// PROTOCOLO (exacto al que consume minecraft/puente_cliente.py del lado Python):
//   mindcraft -> Sira:
//     { self:{x,y,z,health,hunger,biome,gamemode,yaw},
//       blocks:[{name,x,y,z}...], entities:[{name,x,y,z}...],
//       inventory:[{name,count}...], players:["nombre"...] }     <- world_state periódico
//     { feedback: "texto del resultado de una acción" }          <- al terminar acciones
//   Sira -> mindcraft:
//     { intencion: "texto en español natural" }                  <- se inyecta al agente
//
// INTEGRACIÓN EN MINDCRAFT (2 líneas):
//   En src/agent/agent.js (o donde el agente termina de inicializar, tras crear el bot):
//       import { iniciarSiraBridge } from '../../SiraBridge.mjs';   // ajusta la ruta
//       iniciarSiraBridge(this);   // 'this' = la instancia del Agent (con .bot adentro)
//
//   FEEDBACK: dos vías —
//   (A) Preferida: donde mindcraft obtiene el resultado de ejecutar un comando
//       (el texto que loguea como "Agent executed: X and got: Y"), añade:
//           global.siraBridge?.sendFeedback(`Action output:\n${resultado}`);
//   (B) Automática (sin tocar nada más): este bridge intercepta console.log y
//       reenvía como feedback las líneas que empiezan con "Agent executed:".
//       Funciona out-of-the-box; la vía (A) es más limpia si encuentras el punto.
//
// Requiere:  npm install ws     (en la carpeta de mindcraft)
// ============================================================================

import { WebSocketServer } from 'ws';

const PUERTO_BRIDGE   = 48291;
const INTERVALO_MAPA  = 2500;   // ms entre snapshots del mundo
const RADIO_BLOQUES   = 16;     // distancia de escaneo de bloques
const MAX_BLOQUES     = 40;     // el lado Python agrupa y recorta; mandamos crudo
const RADIO_ENTIDADES = 24;
const VISION_GRADOS   = 360;    // 360 = radar completo | 180 = solo lo que ENFRENTA (como la version original)

// Bloques que no aportan al mapa (el aire y familia)
const IGNORADOS = new Set(['air', 'cave_air', 'void_air', 'bedrock']);

export function iniciarSiraBridge(agent) {
    const bot = agent.bot;
    const wss = new WebSocketServer({ port: PUERTO_BRIDGE });
    let clienteSira = null;
    let timerMapa   = null;

    console.log(`[SiraBridge] Servidor WS escuchando en :${PUERTO_BRIDGE}`);

    // ── Utilidad: enviar JSON al cliente si está conectado ──
    function enviar(obj) {
        if (clienteSira && clienteSira.readyState === 1) {
            try { clienteSira.send(JSON.stringify(obj)); } catch (e) { /* silencioso */ }
        }
    }

    // ── EL MAPA: construir el world_state desde mineflayer ──
    function construirWorldState() {
        try {
            const pos = bot.entity?.position;
            if (!pos) return null;

            // self
            let bioma = 'desconocido';
            try {
                const b = bot.blockAt(pos);
                bioma = b?.biome?.name ?? 'desconocido';
            } catch (e) { /* según versión */ }

            const self = {
                x: pos.x, y: pos.y, z: pos.z,
                health:   bot.health ?? 20,
                hunger:   bot.food ?? 20,
                biome:    bioma,
                gamemode: bot.game?.gameMode ?? 'survival',
                yaw:      bot.entity.yaw ?? 0.0,
            };

            // blocks — lo interesante alrededor (Python agrupa por tipo y pone direcciones)
            const blocks = [];
            try {
                const posiciones = bot.findBlocks({
                    matching: (blk) => blk && blk.name && !IGNORADOS.has(blk.name),
                    maxDistance: RADIO_BLOQUES,
                    count: MAX_BLOQUES,
                });
                // Campo visual: con VISION_GRADOS=180, solo el hemisferio que el bot ENFRENTA
                const yaw = bot.entity.yaw ?? 0;
                const fx = -Math.sin(yaw), fz = Math.cos(yaw);   // hacia dónde mira (convención MC)
                const cosLimite = Math.cos((VISION_GRADOS / 2) * Math.PI / 180);
                for (const p of posiciones) {
                    if (VISION_GRADOS < 360) {
                        const dx = p.x - pos.x, dz = p.z - pos.z;
                        const d  = Math.hypot(dx, dz);
                        if (d > 0.5 && ((dx * fx + dz * fz) / d) < cosLimite) continue;  // fuera del cono
                    }
                    const blk = bot.blockAt(p);
                    if (blk) blocks.push({ name: blk.name, x: p.x, y: p.y, z: p.z });
                }
            } catch (e) { /* mundo sin cargar aún */ }

            // entities — seres vivos cercanos (sin el propio bot)
            const entities = [];
            for (const e of Object.values(bot.entities || {})) {
                if (!e || e === bot.entity || !e.position) continue;
                const d = e.position.distanceTo(pos);
                if (d > RADIO_ENTIDADES) continue;
                const nombre = e.username || e.name || e.displayName || 'entidad';
                if (nombre === bot.username) continue;
                entities.push({ name: nombre, x: e.position.x, y: e.position.y, z: e.position.z });
            }

            // inventory — agregado por nombre
            const inv = {};
            for (const it of (bot.inventory?.items() || [])) {
                inv[it.name] = (inv[it.name] || 0) + it.count;
            }
            const inventory = Object.entries(inv).map(([name, count]) => ({ name, count }));

            // players — los humanos presentes
            const players = Object.keys(bot.players || {}).filter(n => n !== bot.username);

            return { self, blocks, entities, inventory, players };
        } catch (e) {
            return null;
        }
    }

    // ── FEEDBACK vía intercepción de console.log (vía B, automática) ──
    const _logOriginal = console.log.bind(console);
    console.log = (...args) => {
        _logOriginal(...args);
        try {
            const linea = args.map(a => String(a)).join(' ');
            if (linea.startsWith('Agent executed:') || linea.includes('and got:')) {
                enviar({ feedback: linea });
            }
        } catch (e) { /* nunca romper el log */ }
    };

    // ── API pública para la vía A (más limpia) ──
    global.siraBridge = {
        sendFeedback: (texto) => enviar({ feedback: String(texto) }),
    };

    // ── Conexión del cliente (el puente Python de Sira) ──
    wss.on('connection', (ws) => {
        console.log('[SiraBridge] Sira conectada ✓');
        clienteSira = ws;

        // El mapa fluye SIEMPRE mientras haya conexión
        if (timerMapa) clearInterval(timerMapa);
        timerMapa = setInterval(() => {
            const estado = construirWorldState();
            if (estado) enviar(estado);
        }, INTERVALO_MAPA);

        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data && typeof data.intencion === 'string' && data.intencion.trim()) {
                    const texto = data.intencion.trim();
                    console.log(`[SiraBridge] intención de Sira: ${texto}`);
                    // Inyectar al agente como mensaje de 'Sira' (el traductor Qwen lo procesa)
                    agent.handleMessage('Sira', texto);
                }
            } catch (e) { /* mensaje no-JSON: ignorar */ }
        });

        ws.on('close', () => {
            console.log('[SiraBridge] Sira desconectada');
            if (clienteSira === ws) clienteSira = null;
            if (timerMapa) { clearInterval(timerMapa); timerMapa = null; }
        });
    });
}
