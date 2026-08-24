import Groq from 'groq-sdk'
import https from 'https';
import { getKey } from '../utils/keys.js';

// ── AGENTE IPv4 FORZADO (22/8/26) ────────────────────────────────────────
// SÍNTOMA: todas las llamadas a api.groq.com morían con ETIMEDOUT y el bot
// contestaba "My brain disconnected, try again." Sira (Python) hablaba con el
// MISMO endpoint, la MISMA clave y el MISMO momento, sin un solo fallo.
//
// CÓMO SE AISLÓ, en este orden:
//   1. La clave sirve            → llamada de prueba desde Python: respondió.
//   2. La red llega              → IPv4 conecta en 299 ms; IPv6 falla en 0 ms.
//   3. Node conecta bien         → https.get con { family: 4 } devolvió 401
//                                  (401 = llegó, solo faltaba la clave).
//   4. node-fetch NO             → fetch('...') pelado → ETIMEDOUT.
//   5. node-fetch CON agente SÍ  → mismo fetch + https.Agent({family:4}) → 401.
//
// CAUSA: el SDK de Groq usa node-fetch v2, que arma su PROPIO agente HTTPS
// interno. Ese agente no respeta net.setDefaultAutoSelectFamily(false), ni el
// parche de dns.lookup, ni --dns-result-order=ipv4first: se lo salta todo e
// intenta IPv6 igual. Como el IPv6 de esta conexión no rutea, cada intento
// muere. Por eso el arreglo tiene que ir ACÁ y no en main.js: es el único
// lugar donde se le puede pasar un agente propio.
//
// family: 4   → solo IPv4, que es lo que rutea.
// keepAlive   → reusa la conexión TCP entre llamadas. En una red lenta el
//               handshake TLS es la parte cara; ahorrarlo se nota mucho.
const agenteIPv4 = new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 60000,
});

// THIS API IS NOT TO BE CONFUSED WITH GROK!
// Go to grok.js for that. :)

// Umbrella class for everything under the sun... That GroqCloud provides, that is.
export class GroqCloudAPI {

    static prefix = 'groq';

    constructor(model_name, url, params) {

        this.model_name = model_name;
        this.url = url;
        this.params = params || {};

        // Remove any mention of "tools" from params:
        if (this.params.tools)
            delete this.params.tools;
        // This is just a bit of future-proofing in case we drag Mindcraft in that direction.

        // I'm going to do a sneaky ReplicateAPI theft for a lot of this, aren't I?
        if (this.url)
            console.warn("Groq Cloud has no implementation for custom URLs. Ignoring provided URL.");

        this.groq = new Groq({
            apiKey: getKey('GROQCLOUD_API_KEY'),
            httpAgent: agenteIPv4,   // ← sin esto: ETIMEDOUT siempre (ver arriba)
            timeout: 60000,          // 60 s: la conexión es lenta, mejor esperar que fallar
            maxRetries: 2,
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = null) {

        // Construct messages array
        let messages = [{"role": "system", "content": systemMessage}].concat(turns);

        let res = null;

        try {
            console.log("Awaiting Groq response...");

            // Handle deprecated max_tokens parameter
            if (this.params.max_tokens) {
                console.warn("GROQCLOUD WARNING: A profile is using `max_tokens`. This is deprecated. Please move to `max_completion_tokens`.");
                this.params.max_completion_tokens = this.params.max_tokens;
                delete this.params.max_tokens;
            }

            if (!this.params.max_completion_tokens) {
                this.params.max_completion_tokens = 4000;
            }

            let completion = await this.groq.chat.completions.create({
                "messages": messages,
                "model": this.model_name || "qwen/qwen3-32b",
                "stream": false,
                "stop": stop_seq,
                ...(this.params || {})
            });

            res = completion.choices[0].message.content;
            res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }
        catch(err) {
            if (err.message.includes("content must be a string")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = messages.filter(message => message.role !== 'system');
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages);
    }

    async embed(_) {
        throw new Error('Embeddings are not supported by Groq.');
    }
}