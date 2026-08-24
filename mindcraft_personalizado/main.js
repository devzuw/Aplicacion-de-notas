import net from 'net';
import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

// ── FIX DE CONEXIÓN — happy eyeballs (22/8/26) ───────────────────────────
// SÍNTOMA: todas las llamadas a api.groq.com morían con ETIMEDOUT, mientras
// que Sira (Python) llamaba al MISMO endpoint con la MISMA clave sin problema.
//
// CAUSA: Node 20+ trae "autoSelectFamily" activo por defecto. Prueba las
// direcciones (IPv6 e IPv4) en paralelo y le da a cada una solo 250 ms para
// conectar antes de descartarla. Esta conexión tarda ~3500 ms en abrir el
// socket TCP a Groq (medido), o sea CATORCE VECES el límite: ningún intento
// alcanzaba a completar y Node reportaba timeout como si fuera la red.
// Python no tiene ese límite, por eso Sira funcionaba y esto no.
//
// Se apaga acá adentro y no con NODE_OPTIONS para no depender de arrancar
// siempre con el flag puesto — si se olvida una vez, vuelve el mismo error
// y parece un problema de clave o de red.
//
// Si algún día la conexión mejora, esto no molesta: solo desactiva una
// optimización que sirve en redes rápidas.
net.setDefaultAutoSelectFamily(false);
// Cinturón extra por si algo vuelve a activarlo. 120 s por intento: un
// disparate en cualquier red normal, pero acá el socket a Groq tardó 3478 ms
// en abrir con la máquina tranquila — y con el server de Minecraft, el cliente
// y Sira compitiendo por la misma subida de 1.5 Mbps, puede irse mucho más.
// Poner un margen gigante no cuesta nada: si conecta rápido, no espera; el
// número solo marca cuánto AGUANTA antes de rendirse.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(120000);
}

// ── Y EL QUE DE VERDAD LO ARREGLA: FORZAR IPv4 EN EL DNS ─────────────────
// Lo de arriba no alcanzó, y la razón está en el traceback del error:
//     node-fetch/lib/index.js:1501
// El SDK de Groq usa node-fetch (la librería vieja), que arma SU PROPIO
// agente HTTPS y no respeta setDefaultAutoSelectFamily ni nada del agente
// global. Por eso seguía intentando IPv6 aunque Node estuviera configurado
// para no hacerlo.
//
// PRUEBA que lo confirma: https.get con { family: 4 } contra api.groq.com
// devolvió 401 al instante (401 = llegó bien, solo faltaba la clave).
// O sea: Node conecta perfecto por IPv4. El que se perdía era node-fetch.
//
// Acá se parchea dns.lookup para TODO el proceso: cualquier librería que
// resuelva un nombre recibe solo direcciones IPv4. Es la única capa por la
// que pasan todas, incluida node-fetch.
// El IPv6 de esta conexión falla en 0 ms (medido), así que no se pierde nada.
const dns = await import('dns');
const _lookupOriginal = dns.default.lookup;
dns.default.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    options = { ...(typeof options === 'object' ? options : {}), family: 4 };
    return _lookupOriginal.call(this, hostname, options, callback);
};
// El módulo de promesas va por su lado, así que también.
if (dns.default.promises && dns.default.promises.lookup) {
    const _lookupPromesa = dns.default.promises.lookup;
    dns.default.promises.lookup = function (hostname, options = {}) {
        return _lookupPromesa.call(this, hostname, { ...options, family: 4 });
    };
}

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}

const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        settings.task = tasks[args.task_id];
        settings.task.task_id = args.task_id;
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = process.env.MINECRAFT_PORT;
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = process.env.MINDSERVER_PORT;
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) {
    settings.allow_insecure_coding = true;
}
if (process.env.BLOCKED_ACTIONS) {
    settings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
}
if (process.env.MAX_MESSAGES) {
    settings.max_messages = process.env.MAX_MESSAGES;
}
if (process.env.NUM_EXAMPLES) {
    settings.num_examples = process.env.NUM_EXAMPLES;
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL;
}
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}

Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

for (let profile of settings.profiles) {
    const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    settings.profile = profile_json;
    Mindcraft.createAgent(settings);
}